#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, configPaths, PROFILES } from './catalog.mjs';
import { detect, describeCommand } from './agents.mjs';
import { indexSkills, rankSkills, findSkill } from './skills.mjs';
import { validatePlan, route } from './router.mjs';
import { run } from './runner.mjs';
import { findIssueRef, getIssue, addComment, jiraSettings, renderIssue } from './jira.mjs';
import { resolvePr, feedback, reply, renderFeedback, gate } from './pr.mjs';
import { notify, notifySettings } from './notify.mjs';
import { runSetup, readStamp, saveUserConfig } from './setup.mjs';
import { collect, render } from './transcripts.mjs';
import { runAcceptance, renderReport, saveReport, loadReport, readiness, renderReadiness, lockAcceptance, acceptanceChanged, verifySkillStatus, renderVerifySkill, recordVerdict, loadVerdict, judgeVerdict, authorsOf, patchId, defaultBase, VERDICTS } from './verify.mjs';
import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { loadRules, branchName, lintBranch, lintCommit, lintPrTitle, findKey } from './conventions.mjs';
import { KIND_FLOORS } from './catalog.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = ['orchestrate', 'orch-setup', 'orch-me', 'orch-verify', 'orch-retro', 'orch-eval'];

const HELP = `orch - route tasks across your installed coding agents

  orch setup [--check]             one-time check: agents, GitHub, Jira connector, alerts
  orch setup --profile <p> --role <kind>=<model>   save your defaults (--role <kind>= or --clear-profile undoes one)
  orch roles                       which model each kind of task gets, and which are pinned
  orch transcripts [--days N] [--all]   your own messages from recent sessions in this project
  orch link <skill-dir>            link a skill folder into every agent
  orch detect                      which agent CLIs are usable
  orch models                      the model catalog used for routing
  orch skills "<task>" [--top N]   installed skills ranked for a task
  orch route <plan.json>           assign a model to every task, estimate cost
  orch run <plan.json>             route, then execute the plan
  orch verify <plan.json> [--prove] [--repeat 2] [--base <ref>]   run the acceptance criteria: pass, fail or needs a human
  orch verdict <PASS|PASS+NOTES|FAIL|INCONCLUSIVE> --by <agent/model>   record an independent verdict for this change
  orch verify-skill                does this project have a current verify skill for e2e checks?
  orch pr gate <pr> [--approve human|observe|auto]   publish the verdict on the PR; auto enables auto-merge on a pass
  orch pr feedback <pr> [--wait <min>]        unanswered review threads, bot findings, failed checks
  orch pr reply <thread-id> "<text>" [--resolve]
  orch branch <type> [<KEY>] <summary...>     branch name: feat/PROJ-123-short-slug
  orch lint [--base <ref>] [--key <KEY>]      branch name and commits since base, commitlint style, key included
  orch lint --title "<pr title>" | --message "<commit message>"   check one PR title or commit message
  orch notify "<message>" [--title <t>]       desktop notification and webhook, if set
  orch jira get <KEY|url>          fallback when no Atlassian connector: needs JIRA_* env vars
  orch install | uninstall         link the skills into each agent

Options for route and run:
  --profile cheap|balanced|fast|quality   (optional; unset means quality)
  --budget <usd>         cap for the whole plan
  --relax                let tasks drop below their quality floor to fit the budget
  --agents a,b           only use these agents
  --concurrency <n>      parallel tasks (default 4)
  --only a,b             run: just these tasks, for a review or rework round
  --dry-run              run: show the commands without executing
  --force                run: start even when the estimate is over budget
  --min-confidence <n>   plan confidence needed to start alone (default 70)
  --start-anyway         run: start below that confidence, on the user's say-so
  --json                 machine-readable output
`;

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd()).join('\n');
}

const usd = (n) => (n == null ? '-' : n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

async function usableAgents(config, only) {
  const found = await detect(config);
  let names = found.filter((a) => a.available).map((a) => a.name);
  if (only) names = names.filter((n) => only.split(',').includes(n));
  // An agent whose own default model is unusable runs on its fallback instead.
  for (const a of found) {
    if (!a.fallbackModel) continue;
    for (const m of config.models) if (m.agent === a.name && m.model == null) m.model = a.fallbackModel;
  }
  return { found, names };
}

function loadPlan(path) {
  if (!path) throw new Error('Pass a plan file: orch route plan.json');
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  const errors = validatePlan(plan);
  if (errors.length) throw new Error(`Invalid plan:\n  - ${errors.join('\n  - ')}`);
  return plan;
}

function printRoute(routed) {
  const rows = [['TASK', 'KIND', 'SIZE', 'MODE', 'MODEL', 'EST']];
  for (const t of routed.tasks) {
    const a = t.assignment;
    if (!a) {
      rows.push([t.id, '-', '-', '-', 'needs a human', '-']);
      continue;
    }
    rows.push([t.id, t.kind, t.complexity, t.mode, a.id, `${a.priceEstimated ? '~' : ''}${usd(a.estUsd)}`]);
  }
  console.log(table(rows));
  const cap = routed.budget != null ? ` of ${usd(routed.budget)} budget` : '';
  console.log(`\nprofile ${routed.profile}, estimated ${usd(routed.totalUsd)}${cap}${routed.status === 'over_budget' ? '  OVER BUDGET' : ''}`);
  for (const t of routed.tasks) if (t.needsHuman) console.log(`needs a human: ${t.id}: ${t.needsHuman}`);
  for (const note of routed.notes) console.log(`note: ${note}`);
}

function installTargets(dirs = ['.claude', '.codex', '.agents']) {
  const home = homedir();
  return dirs
    .map((d) => join(home, d, 'skills'))
    .filter((d) => existsSync(d))
    .flatMap((d) => SKILLS.map((name) => ({ target: join(d, name), source: join(ROOT, 'skills', name) })));
}

function isOurLink(path, source) {
  try {
    return lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === source;
  } catch {
    return false;
  }
}

const commands = {
  async detect({ values }) {
    const config = loadConfig();
    const found = await detect(config);
    if (values.json) return console.log(JSON.stringify(found, null, 2));
    const rows = [['AGENT', 'STATUS', 'VERSION']];
    for (const a of found) rows.push([a.name, a.available ? 'ready' : a.reason, a.version ?? '']);
    console.log(table(rows));
    for (const a of found) if (a.note) console.log(`note: ${a.name}: ${a.note}`);
  },

  async models({ values }) {
    const config = loadConfig();
    if (values.json) return console.log(JSON.stringify(config.models, null, 2));
    const rows = [['MODEL', 'IN $/M', 'OUT $/M', 'QUALITY', 'SPEED', 'EFFORTS']];
    for (const m of config.models) {
      rows.push([m.id, `${m.priceEstimated ? '~' : ''}${m.in}`, `${m.priceEstimated ? '~' : ''}${m.out}`, m.quality, m.speed, (m.efforts ?? []).join(',') || '-']);
    }
    console.log(table(rows));
    console.log(`\n~ = placeholder price. Override in ${configPaths()[0]}`);
  },

  async skills({ values, positionals }) {
    const all = indexSkills();
    const query = positionals.join(' ');
    const list = query ? rankSkills(all, query, Number(values.top ?? 8)) : all;
    if (values.json) return console.log(JSON.stringify(list, null, 2));
    if (!list.length) return console.log(query ? 'No installed skill matches.' : 'No skills found.');
    for (const s of list) {
      const score = s.score != null ? `  [${s.score}]` : '';
      console.log(`${s.bundled ? `pstack:${s.name}` : s.name}${score}  (${s.agents.join(', ')})${s.shadowed ? '  [you have your own skill with this name]' : ''}\n  ${s.description.slice(0, 200)}\n  ${s.path}`);
    }
  },

  async route({ values, positionals }) {
    const config = loadConfig();
    const plan = loadPlan(positionals[0]);
    const { names } = await usableAgents(config, values.agents);
    const routed = route(plan, {
      models: config.models,
      agents: names,
      profile: values.profile ?? plan.profile ?? config.profile,
      budget: values.budget != null ? Number(values.budget) : (plan.budget ?? config.budget),
      relax: Boolean(values.relax),
      roles: config.roles,
    });
    routed.readiness = readiness(plan, Number(values['min-confidence'] ?? config.minConfidence));
    if (values.json) console.log(JSON.stringify(routed, null, 2));
    else {
      printRoute(routed);
      console.log(`\n${renderReadiness(routed.readiness)}`);
      console.log(renderVerifySkill(verifySkillStatus(process.cwd())));
    }
    // 0 ready to start, 4 raise to a human first
    if (routed.readiness.decision === 'raise') process.exitCode = 4;
    return routed;
  },

  async run({ values, positionals }) {
    const config = loadConfig();
    if (values.concurrency) config.concurrency = Number(values.concurrency);
    const plan = loadPlan(positionals[0]);
    // --only runs a subset, for a review or rework round on a plan already under way.
    if (values.only) {
      const keep = new Set(values.only.split(','));
      const unknown = [...keep].filter((id) => !plan.tasks.some((t) => t.id === id));
      if (unknown.length) throw new Error(`--only names tasks that are not in the plan: ${unknown.join(', ')}`);
      plan.tasks = plan.tasks.filter((t) => keep.has(t.id)).map((t) => ({ ...t, deps: (t.deps ?? []).filter((d) => keep.has(d)) }));
    }
    const { names } = await usableAgents(config, values.agents);
    const routed = route(plan, {
      models: config.models,
      agents: names,
      profile: values.profile ?? plan.profile ?? config.profile,
      budget: values.budget != null ? Number(values.budget) : (plan.budget ?? config.budget),
      relax: Boolean(values.relax),
      roles: config.roles,
    });
    const cwd = process.cwd();
    const ready = readiness(plan, Number(values['min-confidence'] ?? config.minConfidence));
    if (!values.json) {
      printRoute(routed);
      console.log(`\n${renderReadiness(ready)}`);
    }
    if (values['dry-run']) {
      console.log('');
      for (const t of routed.tasks) console.log(`${t.id}: ${describeCommand({ assignment: t.assignment, mode: t.mode, cwd })}`);
      return;
    }
    if (process.env.CODEX_SANDBOX) {
      console.error("\nCannot start workers from inside Codex's sandbox: they need network access and their own sandbox.\nRerun this exact command with escalated permissions (outside the sandbox).");
      process.exitCode = 3;
      return;
    }
    if (ready.decision === 'raise' && !values['start-anyway']) {
      console.error('\nNot starting: confidence is too low to run without a human. Raise the items above with the user, update the plan, and run again. --start-anyway overrides, only on their say-so.');
      process.exitCode = 4;
      return;
    }
    if (routed.status === 'over_budget' && !values.force) {
      console.error('\nEstimate is over budget. Raise --budget, pass --relax to trade quality, or --force to run anyway.');
      process.exitCode = 2;
      return;
    }
    const skills = indexSkills(cwd);
    for (const t of plan.tasks) {
      if (t.skill && !findSkill(skills, t.skill)) console.error(`note: ${t.id} names skill "${t.skill}", which is not installed. Ignoring it.`);
    }
    lockAcceptance(plan, cwd);
    console.error('');
    const summary = await run(plan, routed, { cwd, config, agents: names, skills, log: (line) => console.error(line) });
    if (values.json) console.log(JSON.stringify(summary, null, 2));
    else {
      const rows = [['TASK', 'STATUS', 'MODEL', 'TIME', 'COST', 'RESULT']];
      for (const t of summary.tasks) if (t.verify) t.status = `${t.status} (check ${t.verify.passed ? 'passed' : 'FAILED'})`;
      for (const t of summary.tasks) rows.push([t.id, t.status, t.model ?? '-', t.seconds != null ? `${t.seconds}s` : '-', usd(t.usd), t.result ?? t.error ?? '']);
      console.log(`\n${table(rows)}`);
      console.log(`\nspent ${usd(summary.spentUsd)} (estimated ${usd(summary.estimatedUsd)})  run dir: ${summary.runDir}`);
    }
    if (!summary.ok) process.exitCode = 1;
  },

  async setup({ values }) {
    if (values.webhook) console.log(`saved webhook to ${saveUserConfig({ notify: { webhook: values.webhook } })}`);
    if (values.profile) console.log(`saved default profile "${values.profile}" to ${saveUserConfig({ profile: values.profile })}`);
    if (values.approve) {
      if (!['human', 'observe', 'auto'].includes(values.approve)) throw new Error('--approve must be human, observe or auto');
      console.log(`saved approve=${values.approve} to ${saveUserConfig({ approve: values.approve })}`);
    }
    if (values['clear-profile']) console.log(`cleared the saved profile in ${saveUserConfig({ profile: undefined })}: back to best quality`);
    if (values.role?.length) {
      const known = loadConfig().models.map((m) => m.id);
      const roles = {};
      for (const pair of values.role) {
        const [kind, model = ''] = pair.split('=');
        if (!(kind in KIND_FLOORS)) throw new Error(`Unknown kind "${kind}". Use ${Object.keys(KIND_FLOORS).join(', ')}`);
        if (model && !known.includes(model.split('@')[0])) throw new Error(`Unknown model "${model}". See \`orch models\`.`);
        roles[kind] = model;
      }
      console.log(`saved roles to ${saveUserConfig({ roles })}`);
    }
    if (values.webhook || values.profile || values.approve || values['clear-profile'] || values.role?.length) return;
    if (values.check) {
      const stamp = readStamp();
      if (stamp?.ok) return console.log(`setup ok (checked ${stamp.at.slice(0, 10)})`);
      console.log('Setup has not been completed. Run: orch setup');
      process.exitCode = 1;
      return;
    }
    const result = await runSetup(loadConfig());
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      const rows = [['', 'CHECK', 'RESULT']];
      for (const c of result.checks) rows.push([c.ok ? '✔' : c.required ? '✖' : '!', c.name, c.detail ?? '']);
      console.log(table(rows));
      for (const c of result.checks) {
        if (c.note) console.log(`\nnote: ${c.name}: ${c.note}`);
        if (!c.ok && c.fix) console.log(`\n${c.required ? 'required' : 'optional'}: ${c.name}\n  ${c.fix}`);
      }
      console.log(result.ok ? '\nReady. Optional items above can be fixed any time; rerun `orch setup` after.' : '\nNot ready: fix the required items, then rerun `orch setup`.');
    }
    if (!result.ok) process.exitCode = 1;
  },

  async jira({ values, positionals }) {
    const [action, target, ...rest] = positionals;
    const ref = findIssueRef(target);
    if (!ref || !['get', 'comment'].includes(action)) throw new Error('Usage: orch jira get <KEY|url>  |  orch jira comment <KEY> "<text>"');
    const settings = jiraSettings(loadConfig());
    if (action === 'comment') {
      if (!rest.length) throw new Error('Comment text is required');
      await addComment(ref.key, rest.join(' '), settings);
      return console.log(`commented on ${ref.key}`);
    }
    const issue = await getIssue(ref, settings);
    console.log(values.json ? JSON.stringify(issue, null, 2) : renderIssue(issue));
  },

  async pr({ values, positionals }) {
    const [action, ...rest] = positionals;
    if (action === 'feedback') {
      const target = await resolvePr(rest[0], values.repo);
      const result = await feedback(target, { waitMinutes: Number(values.wait ?? 0), log: (l) => console.error(l) });
      console.log(values.json ? JSON.stringify(result, null, 2) : renderFeedback(result));
      return;
    }
    if (action === 'gate') {
      const config = loadConfig();
      const approve = values.approve ?? config.approve;
      if (!['human', 'observe', 'auto'].includes(approve)) throw new Error('--approve must be human, observe or auto');
      const target = await resolvePr(rest[0], values.repo);
      const verification = loadReport(process.cwd());
      // A recorded verdict always counts. One is required before anything may
      // merge by itself: auto-merge with only the author's word is not a gate.
      const verdict = loadVerdict(process.cwd());
      let independent = null;
      if (verdict || approve === 'auto' || config.requireVerdict) {
        let current = null;
        try {
          current = patchId(process.cwd(), values.base ?? defaultBase(process.cwd()));
        } catch {}
        independent = judgeVerdict(verdict, { authors: authorsOf(process.cwd()), currentPatchId: current });
      }
      const verdictLine = independent ? `\n**Independent verification:** ${independent.reason}.\n` : '';
      const result = await gate(target, verification, `${renderReport(verification)}${verdictLine}`, { approve, independent });
      // A record to grade the gate against later: did what it passed hold up?
      const history = join(homedir(), '.config', 'orch', 'history.jsonl');
      mkdirSync(dirname(history), { recursive: true });
      appendFileSync(history, `${JSON.stringify({ at: new Date().toISOString(), pr: result.url, head: result.head, gate: result.state, approval: result.approval, verdict: verification.verdict, confidence: verification.readiness?.score ?? null })}\n`);
      console.log(values.json ? JSON.stringify(result, null, 2) : `gate ${result.state}: ${result.description}\napproval: ${result.approval}\n${result.url}`);
      if (result.state === 'failure') process.exitCode = 1;
      else if (result.state === 'pending') process.exitCode = 2;
      return;
    }
    if (action === 'reply') {
      const [threadId, ...text] = rest;
      if (!threadId || !text.length) throw new Error('Usage: orch pr reply <thread-id> "<text>" [--resolve]');
      await reply(threadId, text.join(' '), { resolve: Boolean(values.resolve) });
      return console.log(values.resolve ? 'replied and resolved' : 'replied');
    }
    throw new Error('Usage: orch pr gate <pr> [--approve human|auto]  |  orch pr feedback <pr> [--wait <min>]  |  orch pr reply <thread-id> "<text>" [--resolve]');
  },

  async notify({ values, positionals }) {
    if (!positionals.length) throw new Error('Usage: orch notify "<message>"');
    const sent = await notify(positionals.join(' '), { title: values.title ?? 'orch', settings: notifySettings(loadConfig()) });
    console.log(sent.length ? `sent: ${sent.join(', ')}` : 'no alert channel is on');
  },

  async verify({ values, positionals }) {
    const plan = loadPlan(positionals[0]);
    const cwd = process.cwd();
    if (acceptanceChanged(plan, cwd) && !values.relock) {
      throw new Error('The acceptance criteria changed after the run started. Only the user may change what "done" means: if they agreed to this change, run again with --relock.');
    }
    lockAcceptance(plan, cwd);
    const result = await runAcceptance(plan, { cwd, prove: Boolean(values.prove), repeat: Number(values.repeat ?? 1), base: values.base });
    const paths = saveReport(result, cwd);
    if (values.json) console.log(JSON.stringify(result, null, 2));
    else {
      const rows = [['', 'ID', 'CRITERION', 'CHECK']];
      for (const c of result.criteria) rows.push([{ pass: '✔', fail: '✖', needs_human: '?' }[c.status], c.id, c.criterion.slice(0, 60), c.type === 'manual' ? `human: ${c.manual.slice(0, 50)}` : `${c.check.slice(0, 50)}${c.proof?.failedOnBase ? '  (fails before the change)' : ''}${c.reason ? `  ${c.reason}` : ''}`]);
      console.log(table(rows));
      for (const flag of result.flags) console.log(`\nflag: ${flag}`);
      console.log(`\nverdict: ${result.verdict.toUpperCase().replace('_', ' ')}   report: ${paths.md}`);
    }
    // 0 pass, 1 fail, 2 needs a human
    process.exitCode = { pass: 0, fail: 1, needs_human: 2 }[result.verdict];
  },

  async verdict({ values, positionals }) {
    const cwd = process.cwd();
    if (!positionals.length) {
      const verdict = loadVerdict(cwd);
      if (!verdict) return console.log('No independent verdict recorded. Record one with: orch verdict <PASS|PASS+NOTES|FAIL|INCONCLUSIVE> --by <agent/model> [--notes "..."]');
      let current = null;
      try {
        current = patchId(cwd, values.base ?? defaultBase(cwd));
      } catch {}
      const judged = judgeVerdict(verdict, { authors: authorsOf(cwd), currentPatchId: current });
      console.log(`${verdict.result} by ${verdict.by} at ${verdict.head.slice(0, 10)}${verdict.notes ? `\n  ${verdict.notes}` : ''}\n${judged.ok ? 'counts' : 'does not count'}: ${judged.reason}`);
      return;
    }
    const verdict = recordVerdict(cwd, { result: positionals[0].toUpperCase(), by: values.by, notes: values.notes ?? positionals.slice(1).join(' '), base: values.base });
    const judged = judgeVerdict(verdict, { authors: authorsOf(cwd), currentPatchId: verdict.patchId });
    console.log(`recorded ${verdict.result} by ${verdict.by} for ${verdict.head.slice(0, 10)}\n${judged.ok ? 'counts' : 'does not count'}: ${judged.reason}`);
  },

  async branch({ positionals }) {
    const [type, ...rest] = positionals;
    const key = rest[0] && findKey(rest[0]) === rest[0] ? rest.shift() : null;
    if (!type || !rest.length) throw new Error('Usage: orch branch <type> [<KEY>] <summary...>   e.g. orch branch feat PROJ-123 add rate limiting');
    console.log(branchName({ type, key, summary: rest.join(' ') }, loadRules(process.cwd())));
  },

  async lint({ values }) {
    const cwd = process.cwd();
    const rules = loadRules(cwd);
    const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const report = (label, problems) => {
      console.log(`${problems.length ? '✖' : '✔'} ${label}`);
      for (const p of problems) console.log(`    ${p}`);
      return problems.length;
    };
    if (values.title != null || values.message != null) {
      const key = values.key ?? null;
      const bad = values.title != null ? report(`PR title: ${values.title}`, lintPrTitle(values.title, { rules, key })) : report(`message: ${values.message.split('\n')[0]}`, lintCommit(values.message, { rules, key }));
      process.exitCode = bad ? 1 : 0;
      return;
    }
    const branch = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
    const key = values.key ?? findKey(branch);
    const base = values.base ?? defaultBase(cwd);
    console.log(`rules: ${rules.source}${key ? `, key ${key}` : ', no Jira key'}`);
    let bad = report(`branch ${branch}`, lintBranch(branch, { rules, key }));
    const commits = git('log', '--reverse', '--format=%h%x00%B%x1e', `${base}..HEAD`).split('\x1e').map((c) => c.trim()).filter(Boolean).map((c) => c.split('\0'));
    const local = join(cwd, 'node_modules', '.bin', 'commitlint');
    if (rules.delegate && existsSync(local)) {
      // The repo's own commitlint reads its own config; we add only the key rule.
      console.log(`format: the repo's commitlint (${rules.delegate})`);
      try {
        execFileSync(local, ['--from', base, '--to', 'HEAD'], { cwd, stdio: 'inherit' });
      } catch {
        bad++;
      }
      for (const [sha, msg] of commits) bad += report(`${sha} ${msg.split('\n')[0]}`, key && !msg.includes(key) ? [`does not mention ${key}: add a "Refs: ${key}" footer so Jira links it`] : []);
    } else {
      if (rules.delegate) console.log(`note: ${rules.delegate} needs the repo's commitlint, which is not installed; checking against conventional defaults`);
      for (const [sha, msg] of commits) bad += report(`${sha} ${msg.split('\n')[0]}`, lintCommit(msg, { rules, key }));
    }
    if (!commits.length) console.log('no commits since base');
    process.exitCode = bad ? 1 : 0;
  },

  async 'verify-skill'({ values }) {
    const status = verifySkillStatus(process.cwd());
    console.log(values.json ? JSON.stringify(status, null, 2) : renderVerifySkill(status));
    for (const file of values.json ? [] : status.changed) console.log(`  ${file}`);
    // 0 current, 1 missing, 2 stale or unsynced
    process.exitCode = { current: 0, missing: 1, stale: 2, unsynced: 2 }[status.state];
  },

  async roles({ values }) {
    const config = loadConfig();
    const { names } = await usableAgents(config, values.agents);
    const profile = values.profile ?? config.profile;
    const rows = [['KIND', 'S', 'M', 'L', '']];
    const table_ = {};
    for (const kind of Object.keys(KIND_FLOORS)) {
      const cells = ['S', 'M', 'L'].map((complexity) => {
        const plan = { tasks: [{ id: 'x', kind, complexity, mode: 'read', prompt: 'x' }] };
        return route(plan, { models: config.models, agents: names, profile, roles: config.roles }).tasks[0].assignment.id;
      });
      table_[kind] = cells;
      rows.push([kind, ...cells, config.roles[kind] ? 'pinned' : '']);
    }
    if (values.json) return console.log(JSON.stringify({ profile, roles: config.roles, routing: table_ }, null, 2));
    console.log(table(rows));
    console.log(`\nprofile ${profile}. Pin a kind with: orch setup --role review=claude/opus@high`);
  },

  async transcripts({ values }) {
    const messages = collect({ all: Boolean(values.all), days: Number(values.days ?? 30) });
    if (values.json) return console.log(JSON.stringify(messages, null, 2));
    console.log(messages.length ? render(messages) : 'No messages found. Try --days 90, or --all for every project.');
    console.error(`\n${messages.length} message(s) from ${new Set(messages.map((m) => m.session)).size} session(s)`);
  },

  async link({ positionals }) {
    const source = resolve(positionals[0] ?? '');
    if (!existsSync(join(source, 'SKILL.md'))) throw new Error('Usage: orch link <folder containing SKILL.md>');
    const name = source.split('/').pop();
    for (const dir of ['.claude', '.codex', '.agents'].map((d) => join(homedir(), d, 'skills')).filter((d) => existsSync(d))) {
      const target = join(dir, name);
      if (resolve(target) === source || isOurLink(target, source)) console.log(`ok       ${target}`);
      else if (existsSync(target)) console.log(`skipped  ${target} (something else is already there)`);
      else {
        symlinkSync(source, target);
        console.log(`linked   ${target}`);
      }
    }
  },

  async install() {
    for (const { target, source } of installTargets()) {
      if (isOurLink(target, source)) {
        console.log(`ok       ${target}`);
      } else if (existsSync(target)) {
        console.log(`skipped  ${target} (something else is already there)`);
      } else {
        symlinkSync(source, target);
        console.log(`linked   ${target}`);
      }
    }
    const binDir = join(homedir(), '.local', 'bin');
    const bin = join(binDir, 'orch');
    const wrapper = `#!/bin/sh\n# installed by orch\nexec node "${join(ROOT, 'src', 'cli.mjs')}" "$@"\n`;
    if (existsSync(bin) && !readFileSync(bin, 'utf8').includes('# installed by orch')) {
      console.log(`skipped  ${bin} (something else is already there)`);
    } else {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(bin, wrapper);
      chmodSync(bin, 0o755);
      console.log(`wrote    ${bin}`);
    }
  },

  async uninstall() {
    for (const { target, source } of installTargets(['.claude', '.codex', '.agents', '.cursor'])) {
      if (isOurLink(target, source)) {
        unlinkSync(target);
        console.log(`removed  ${target}`);
      }
    }
    const bin = join(homedir(), '.local', 'bin', 'orch');
    if (existsSync(bin) && readFileSync(bin, 'utf8').includes('# installed by orch')) {
      unlinkSync(bin);
      console.log(`removed  ${bin}`);
    }
  },
};

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
      top: { type: 'string' },
      profile: { type: 'string' },
      budget: { type: 'string' },
      relax: { type: 'boolean' },
      agents: { type: 'string' },
      concurrency: { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      check: { type: 'boolean' },
      webhook: { type: 'string' },
      wait: { type: 'string' },
      repo: { type: 'string' },
      resolve: { type: 'boolean' },
      title: { type: 'string' },
      role: { type: 'string', multiple: true },
      prove: { type: 'boolean' },
      only: { type: 'string' },
      by: { type: 'string' },
      notes: { type: 'string' },
      relock: { type: 'boolean' },
      repeat: { type: 'string' },
      'min-confidence': { type: 'string' },
      'start-anyway': { type: 'boolean' },
      base: { type: 'string' },
      approve: { type: 'string' },
      'clear-profile': { type: 'boolean' },
      all: { type: 'boolean' },
      days: { type: 'string' },
      key: { type: 'string' },
      message: { type: 'string' },
    },
  });
  const [name, ...rest] = positionals;
  if (values.help || !name || !(name in commands)) {
    console.log(HELP);
    if (name && !(name in commands)) process.exitCode = 1;
    return;
  }
  if (values.profile && !(values.profile in PROFILES)) throw new Error(`Unknown profile "${values.profile}"`);
  if (values.budget != null && !(Number(values.budget) > 0)) throw new Error('--budget must be a positive number of dollars');
  await commands[name]({ values, positionals: rest });
}

main().catch((err) => {
  console.error(`orch: ${err.message}`);
  process.exitCode = 1;
});
