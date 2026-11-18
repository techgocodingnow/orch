#!/usr/bin/env node
import { readFileSync, existsSync, mkdirSync, symlinkSync, lstatSync, readlinkSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, configPaths, PROFILES } from './catalog.mjs';
import { detect, describeCommand } from './agents.mjs';
import { indexSkills, rankSkills } from './skills.mjs';
import { validatePlan, route } from './router.mjs';
import { run } from './runner.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_SRC = join(ROOT, 'skills', 'orchestrate');

const HELP = `orch - route tasks across your installed coding agents

  orch detect                      which agent CLIs are usable
  orch models                      the model catalog used for routing
  orch skills "<task>" [--top N]   installed skills ranked for a task
  orch route <plan.json>           assign a model to every task, estimate cost
  orch run <plan.json>             route, then execute the plan
  orch install | uninstall         link the /orchestrate skill into each agent

Options for route and run:
  --profile cheap|balanced|fast|quality   (default: balanced)
  --budget <usd>         cap for the whole plan
  --relax                let tasks drop below their quality floor to fit the budget
  --agents a,b           only use these agents
  --concurrency <n>      parallel tasks (default 4)
  --dry-run              run: show the commands without executing
  --force                run: start even when the estimate is over budget
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
    rows.push([t.id, t.kind, t.complexity, t.mode, a.id, `${a.priceEstimated ? '~' : ''}${usd(a.estUsd)}`]);
  }
  console.log(table(rows));
  const cap = routed.budget != null ? ` of ${usd(routed.budget)} budget` : '';
  console.log(`\nprofile ${routed.profile}, estimated ${usd(routed.totalUsd)}${cap}${routed.status === 'over_budget' ? '  OVER BUDGET' : ''}`);
  for (const note of routed.notes) console.log(`note: ${note}`);
}

function installTargets() {
  const home = homedir();
  return ['.claude', '.codex', '.cursor', '.agents']
    .map((d) => join(home, d, 'skills'))
    .filter((d) => existsSync(d))
    .map((d) => join(d, 'orchestrate'));
}

function isOurLink(path) {
  try {
    return lstatSync(path).isSymbolicLink() && resolve(dirname(path), readlinkSync(path)) === SKILL_SRC;
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
      console.log(`${s.name}${score}  (${s.agents.join(', ')})\n  ${s.description.slice(0, 200)}\n  ${s.path}`);
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
    });
    if (values.json) console.log(JSON.stringify(routed, null, 2));
    else printRoute(routed);
    return routed;
  },

  async run({ values, positionals }) {
    const config = loadConfig();
    if (values.concurrency) config.concurrency = Number(values.concurrency);
    const plan = loadPlan(positionals[0]);
    const { names } = await usableAgents(config, values.agents);
    const routed = route(plan, {
      models: config.models,
      agents: names,
      profile: values.profile ?? plan.profile ?? config.profile,
      budget: values.budget != null ? Number(values.budget) : (plan.budget ?? config.budget),
      relax: Boolean(values.relax),
    });
    const cwd = process.cwd();
    if (!values.json) printRoute(routed);
    if (values['dry-run']) {
      console.log('');
      for (const t of routed.tasks) console.log(`${t.id}: ${describeCommand({ assignment: t.assignment, mode: t.mode, cwd })}`);
      return;
    }
    if (routed.status === 'over_budget' && !values.force) {
      console.error('\nEstimate is over budget. Raise --budget, pass --relax to trade quality, or --force to run anyway.');
      process.exitCode = 2;
      return;
    }
    const skills = indexSkills(cwd);
    for (const t of plan.tasks) {
      if (t.skill && !skills.some((s) => s.name === t.skill)) console.error(`note: ${t.id} names skill "${t.skill}", which is not installed. Ignoring it.`);
    }
    console.error('');
    const summary = await run(plan, routed, { cwd, config, agents: names, skills, log: (line) => console.error(line) });
    if (values.json) console.log(JSON.stringify(summary, null, 2));
    else {
      const rows = [['TASK', 'STATUS', 'MODEL', 'TIME', 'COST', 'RESULT']];
      for (const t of summary.tasks) rows.push([t.id, t.status, t.model ?? '-', t.seconds != null ? `${t.seconds}s` : '-', usd(t.usd), t.result ?? t.error ?? '']);
      console.log(`\n${table(rows)}`);
      console.log(`\nspent ${usd(summary.spentUsd)} (estimated ${usd(summary.estimatedUsd)})  run dir: ${summary.runDir}`);
    }
    if (!summary.ok) process.exitCode = 1;
  },

  async install() {
    for (const target of installTargets()) {
      if (isOurLink(target)) {
        console.log(`ok       ${target}`);
      } else if (existsSync(target)) {
        console.log(`skipped  ${target} (something else is already there)`);
      } else {
        symlinkSync(SKILL_SRC, target);
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
    for (const target of installTargets()) {
      if (isOurLink(target)) {
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
