// Runner: execute a routed plan as a DAG. Read tasks run in parallel, write
// tasks take turns in the shared checkout unless they asked for a worktree.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invoke as realInvoke } from './agents.mjs';
import { escalate } from './router.mjs';

const WORKER_RULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'orchestrate', 'worker.md');
const DEP_EXCERPT = 6000;
const money = (n) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

export function buildPrompt({ plan, task, skill, depResults, branch }) {
  const parts = [];
  if (existsSync(WORKER_RULES)) parts.push(readFileSync(WORKER_RULES, 'utf8').trim());
  if (plan.goal) parts.push(`# Overall goal\n${plan.goal}`);
  parts.push(`# Your task: ${task.title ?? task.id}\n${task.prompt}`);
  if (task.mode === 'read') parts.push('This task is read-only. Do not edit, create or delete files.');
  if (branch) parts.push(`You are alone in a git worktree on branch ${branch}. Commit your finished work to this branch.`);
  if (skill) {
    parts.push(`# Skill\nRead ${skill.path} in full before you start and follow it. Files it references sit next to it.`);
  }
  for (const dep of depResults) {
    const text = dep.text.length > DEP_EXCERPT ? `${dep.text.slice(0, DEP_EXCERPT)}\n[truncated, full text: ${dep.path}]` : dep.text;
    parts.push(`# Result of earlier task "${dep.id}"\n${text}`);
  }
  return `${parts.join('\n\n')}\n`;
}

function makeWorktree(cwd, runId, taskId) {
  const path = join(cwd, '.orch', 'worktrees', `${runId}-${taskId}`);
  const branch = `orch/${runId}/${taskId}`;
  execFileSync('git', ['worktree', 'add', '-b', branch, path], { cwd, stdio: 'pipe' });
  return { path, branch };
}

export async function run(plan, routed, opts) {
  const {
    cwd,
    config,
    agents,
    skills = [],
    invoke = realInvoke,
    log = () => {},
    runId = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-'),
  } = opts;
  const budget = routed.budget;
  const runDir = join(cwd, '.orch', 'runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(cwd, '.orch', '.gitignore'), '*\n');
  writeFileSync(join(runDir, 'plan.json'), JSON.stringify({ plan, routed }, null, 2));

  const assignments = new Map(routed.tasks.map((t) => [t.id, t.assignment]));
  const state = new Map(plan.tasks.map((t) => [t.id, { id: t.id, status: 'pending' }]));
  const priceOf = (a) => config.models.find((m) => m.id === a.modelId);
  let spent = 0;
  let writeBusy = false;
  let running = 0;

  const save = () => writeFileSync(join(runDir, 'state.json'), JSON.stringify({ runId, spent, tasks: [...state.values()] }, null, 2));

  async function attempt(task, assignment, taskCwd, branch) {
    const skill = task.skill ? skills.find((s) => s.name === task.skill) : null;
    const depResults = (task.deps ?? []).map((d) => {
      const path = join(runDir, `${d}.result.md`);
      return { id: d, path, text: existsSync(path) ? readFileSync(path, 'utf8') : '' };
    });
    const prompt = buildPrompt({ plan, task, skill, depResults, branch });
    writeFileSync(join(runDir, `${task.id}.prompt.md`), prompt);
    const remaining = budget != null ? Math.max(0.01, budget - spent) : null;
    // A runaway guard, not a tight leash: estimates are rough.
    const cap = Math.max(assignment.estUsd * 4, 0.5);
    const maxUsd = remaining != null ? Math.min(remaining, task.maxCost ?? cap) : (task.maxCost ?? null);
    return invoke({
      assignment,
      mode: task.mode,
      cwd: taskCwd,
      prompt,
      maxUsd,
      timeoutMs: (config.timeoutMinutes ?? 30) * 60_000,
      logPath: join(runDir, `${task.id}.log`),
      resultPath: join(runDir, `${task.id}.codex-last.md`),
      price: priceOf(assignment),
    });
  }

  async function execute(task) {
    const s = state.get(task.id);
    let assignment = assignments.get(task.id);
    let taskCwd = cwd;
    if (task.isolation === 'worktree') {
      try {
        const wt = makeWorktree(cwd, runId, task.id);
        taskCwd = wt.path;
        s.worktree = wt.path;
        s.branch = wt.branch;
      } catch (err) {
        Object.assign(s, { status: 'failed', error: `could not create worktree: ${err.message.split('\n')[0]}` });
        return;
      }
    }
    log(`▶ ${task.id}  ${assignment.id}  (est ${money(assignment.estUsd)})`);
    let result = await attempt(task, assignment, taskCwd, s.branch);
    let usd = result.usd ?? 0;
    const overBudget = () => budget != null && spent + usd >= budget;
    if (!result.ok && config.escalate && !overBudget()) {
      const next = escalate(task, assignment, config.models, agents);
      if (next) {
        log(`↻ ${task.id}  failed on ${assignment.id} (${result.error}), retrying on ${next.id}`);
        s.escalatedFrom = assignment.id;
        assignment = next;
        result = await attempt(task, assignment, taskCwd, s.branch);
        usd += result.usd ?? 0;
      }
    }
    spent += usd;
    const resultPath = join(runDir, `${task.id}.result.md`);
    writeFileSync(resultPath, result.text || `(no output)\n${result.error ?? ''}\n`);
    Object.assign(s, {
      status: result.ok ? 'done' : 'failed',
      model: assignment.id,
      usd: Math.round(usd * 10000) / 10000,
      usdSource: result.usd == null ? 'unknown' : result.usdSource,
      estUsd: assignment.estUsd,
      seconds: Math.round((result.durationMs ?? 0) / 1000),
      tokens: result.tokens ?? null,
      error: result.ok ? undefined : result.error,
      result: resultPath,
    });
    log(`${result.ok ? '✔' : '✖'} ${task.id}  ${s.seconds}s  ${money(s.usd)}${result.ok ? '' : `  ${result.error}`}`);
  }

  await new Promise((resolve) => {
    const tick = () => {
      for (const task of plan.tasks) {
        const s = state.get(task.id);
        if (s.status !== 'pending') continue;
        const deps = (task.deps ?? []).map((d) => state.get(d).status);
        if (deps.some((d) => d === 'failed' || d === 'skipped')) {
          Object.assign(s, { status: 'skipped', error: 'a dependency did not finish' });
          continue;
        }
        if (deps.some((d) => d !== 'done')) continue;
        if (budget != null && spent >= budget) {
          Object.assign(s, { status: 'skipped', error: 'budget exhausted' });
          continue;
        }
        if (running >= (config.concurrency ?? 4)) continue;
        const exclusive = task.mode === 'write' && task.isolation !== 'worktree';
        if (exclusive && writeBusy) continue;
        if (exclusive) writeBusy = true;
        running++;
        s.status = 'running';
        execute(task)
          .catch((err) => Object.assign(s, { status: 'failed', error: String(err) }))
          .finally(() => {
            running--;
            if (exclusive) writeBusy = false;
            save();
            tick();
          });
      }
      save();
      if (running === 0) resolve();
    };
    tick();
  });

  const tasks = [...state.values()];
  return {
    runId,
    runDir,
    ok: tasks.every((t) => t.status === 'done'),
    spentUsd: Math.round(spent * 10000) / 10000,
    estimatedUsd: routed.totalUsd,
    budget,
    tasks,
  };
}
