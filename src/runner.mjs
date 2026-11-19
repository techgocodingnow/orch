// Runner: execute a routed plan as a DAG. Read tasks run in parallel, write
// tasks take turns in the shared checkout unless they asked for a worktree.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { invoke as realInvoke } from './agents.mjs';
import { escalate } from './router.mjs';
import { findSkill } from './skills.mjs';

const WORKER_RULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'orchestrate', 'worker.md');
// A worker's context is for its own task. Earlier reports arrive as a short
// excerpt and a path, so the worker reads the whole thing only if it needs it.
const DEP_EXCERPT = 1500;
const VERIFY_EXCERPT = 4000;
// After three failed rounds a person looks at it, not a fourth worker.
const MAX_FIX_ROUNDS = 3;

// Run a task's check command. Resolves { passed, output }, never throws.
export function runVerify(command, cwd, timeoutMs = 10 * 60_000) {
  return new Promise((resolve) => {
    let output = '';
    const child = spawn('/bin/sh', ['-c', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ passed: false, output: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ passed: code === 0, output: output.slice(-VERIFY_EXCERPT) });
    });
  });
}
const money = (n) => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

export function buildPrompt({ plan, task, skill, depResults, branch, verify, failure }) {
  const parts = [];
  if (existsSync(WORKER_RULES)) parts.push(readFileSync(WORKER_RULES, 'utf8').trim());
  if (plan.goal) parts.push(`# Overall goal\n${plan.goal}`);
  parts.push(`# Your task: ${task.title ?? task.id}\n${task.prompt}`);
  if (task.mode === 'read') parts.push('This task is read-only. Do not edit, create or delete files.');
  if (branch) parts.push(`You are alone in a git worktree on branch ${branch}. Commit your finished work to this branch.`);
  if (skill) {
    parts.push(`# Skill\nRead ${skill.path} in full before you start and follow it. Files it references sit next to it.`);
    if (skill.bundled) parts.push('That skill was written for Cursor. Where it names a Cursor tool or a model, use your own equivalent. Where it tells you to spawn subagents or other models, do that part yourself in this session. Skip any step that needs a Cursor-only feature and say so in your report.');
  }
  if (verify) parts.push(`# Check\nYour work is accepted only when this command exits 0 from the project root:\n\n    ${verify}\n\nRun it yourself before you finish.`);
  for (const dep of depResults) {
    const text = dep.text.length > DEP_EXCERPT ? `${dep.text.slice(0, DEP_EXCERPT)}\n[excerpt. Read the full report at ${dep.path} if your task depends on its detail.]` : dep.text;
    parts.push(`# Result of earlier task "${dep.id}"\n${text}`);
  }
  if (failure) {
    parts.push(`# Your previous attempt failed the check\nThe changes from that attempt are still in the working tree. Fix them, do not start over. Fix the code, never the check: do not edit, skip or loosen a test to make it pass.\n\nPrevious report:\n${failure.report}\n\nOutput of \`${verify}\`:\n${failure.output}`);
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
    verifyCommand = runVerify,
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

  const verifyFor = (task) => task.verify ?? (task.mode === 'write' ? plan.verify : null) ?? null;

  async function attempt(task, assignment, taskCwd, branch, failure) {
    const skill = findSkill(skills, task.skill);
    const depResults = (task.deps ?? []).map((d) => {
      const path = join(runDir, `${d}.result.md`);
      return { id: d, path, text: existsSync(path) ? readFileSync(path, 'utf8') : '' };
    });
    const prompt = buildPrompt({ plan, task, skill, depResults, branch, verify: verifyFor(task), failure });
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
    // No task counts as done until its check passes. A failing check goes back
    // to a worker with the output, the second time on a stronger model.
    const verify = verifyFor(task);
    if (result.ok && verify) {
      s.verify = { command: verify, passed: false, rounds: 0 };
      for (;;) {
        const check = await verifyCommand(verify, taskCwd);
        s.verify.passed = check.passed;
        if (check.passed) break;
        log(`✖ ${task.id}  check failed: ${verify}`);
        if (s.verify.rounds >= MAX_FIX_ROUNDS || overBudget()) {
          result = { ...result, ok: false, error: `check still failing after ${s.verify.rounds} fix round(s): ${verify}`, text: `${result.text}\n\n## Check output\n${check.output}` };
          break;
        }
        s.verify.rounds++;
        if (s.verify.rounds === MAX_FIX_ROUNDS && config.escalate) assignment = escalate(task, assignment, config.models, agents) ?? assignment;
        log(`↻ ${task.id}  fix round ${s.verify.rounds} on ${assignment.id}`);
        const fix = await attempt(task, assignment, taskCwd, s.branch, { report: result.text, output: check.output });
        usd += fix.usd ?? 0;
        if (!fix.ok) {
          result = fix;
          break;
        }
        result = fix;
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
        if (task.needsHuman) {
          Object.assign(s, { status: 'needs_human', error: task.needsHuman });
          log(`✋ ${task.id}  needs a human: ${task.needsHuman}`);
          continue;
        }
        const deps = (task.deps ?? []).map((d) => state.get(d).status);
        if (deps.some((d) => d === 'needs_human')) {
          Object.assign(s, { status: 'skipped', error: 'waiting on a human decision' });
          continue;
        }
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
    needsHuman: tasks.filter((t) => t.status === 'needs_human').map((t) => ({ id: t.id, reason: t.error })),
    spentUsd: Math.round(spent * 10000) / 10000,
    estimatedUsd: routed.totalUsd,
    budget,
    tasks,
  };
}
