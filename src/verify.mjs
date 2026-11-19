// PR verification: every plan defines acceptance criteria, each with a check
// command or a named thing a human must look at. Running them gives one
// verdict: pass, fail, or needs_human.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runVerify } from './runner.mjs';
import { parseFrontmatter } from './skills.mjs';
import { readdirSync, realpathSync } from 'node:fs';

// Untracked dependency folders a base checkout needs before its tests can run.
const LINK_DIRS = ['node_modules', '.venv', 'venv', 'vendor'];

const isPercent = (n) => typeof n === 'number' && n >= 0 && n <= 100;

// What kind of check it is bounds how much a pass can be trusted, whatever the
// planner rated it. A test that drives the real system is hard to fool; one
// that reads source text is easy to satisfy with the feature broken.
export const KIND_CAPS = { e2e: 100, property: 90, differential: 90, unit: 80, static: 60 };
const UNKNOWN_KIND_CAP = 60;
export const effectiveConfidence = (c) => (isPercent(c.confidence) ? Math.min(c.confidence, KIND_CAPS[c.kind] ?? UNKNOWN_KIND_CAP) : 0);

// How safe is it to start this plan with nobody watching?
//
// The planner rates two things, each 0-100: how well it understood the task
// (plan.confidence.understanding) and, per criterion, how sure it is that a
// passing check means the criterion really holds. The score combines them, and
// the weakest check counts as much as the average, because one hollow check is
// enough to ship a wrong PR. Anything unrated counts as 0.
//
// The run starts alone when the score reaches the threshold and nothing is
// rated under HARD_FLOOR. Items between the two are noted as weak, not raised.
export const HARD_FLOOR = 50;

export function readiness(plan, threshold = 70) {
  const raise = [];
  const notes = [];
  const weakItems = [];
  const conf = plan.confidence ?? {};
  const rated = isPercent(conf.understanding);
  const understanding = rated ? conf.understanding : 0;
  if (!rated) raise.push('The plan does not rate how well the task was understood (confidence.understanding).');
  else if (understanding < threshold) (understanding < HARD_FLOOR ? raise : weakItems).push(`Understanding of the task is ${understanding}%${conf.why ? `: ${conf.why}` : ''}`);

  const checks = (plan.acceptance ?? []).filter((c) => c.check);
  const manual = (plan.acceptance ?? []).filter((c) => c.manual);
  let verification = 0;
  if (!(plan.acceptance ?? []).length) raise.push('The plan defines no acceptance criteria, so nothing can say whether the PR passed.');
  else if (!checks.length) raise.push('No criterion has an automatic check: every one needs a person.');
  else {
    const scores = checks.map(effectiveConfidence);
    verification = 0.5 * (scores.reduce((a, b) => a + b, 0) / scores.length) + 0.5 * Math.min(...scores);
    for (const c of checks) {
      if (!isPercent(c.confidence)) raise.push(`Criterion "${c.id}" has no confidence rating.`);
      else {
        const eff = effectiveConfidence(c);
        const capped = eff < c.confidence ? ` (rated ${c.confidence}, capped: ${c.kind ? `a ${c.kind} check` : 'no kind given'})` : '';
        if (eff < threshold) (eff < HARD_FLOOR ? raise : weakItems).push(`Criterion "${c.id}": only ${eff}% sure its check proves it${capped}${c.why ? `: ${c.why}` : ''}`);
      }
    }
  }
  const score = Math.round(0.4 * understanding + 0.6 * verification);
  const assumptions = conf.assumptions ?? [];
  // Below the bar, each guess made in place of asking becomes a question.
  const weak = score < threshold || raise.length > 0;
  // Weak spots are questions when the run is held, and warnings when it is not.
  if (weak) raise.push(...weakItems, ...assumptions.map((a) => `Assumed, please confirm: ${a}`));
  else notes.push(...weakItems.map((w) => `Weak: ${w}`), ...assumptions.map((a) => `Assumed: ${a}`));
  for (const c of manual) notes.push(`"${c.id}" needs a person at approval: ${c.manual}`);
  for (const t of plan.tasks ?? []) if (t.needsHuman) notes.push(`Task "${t.id}" waits on a person: ${t.needsHuman}`);
  return {
    score,
    threshold,
    decision: weak ? 'raise' : 'start',
    understanding,
    verification: Math.round(verification),
    raise,
    notes,
  };
}

export function renderReadiness(r) {
  const lines = [`confidence ${r.score}/100 (understanding ${r.understanding}, verification ${r.verification}; needs ${r.threshold} to start alone)`];
  lines.push(r.decision === 'start' ? 'decision: START without a human' : 'decision: RAISE to a human before starting');
  for (const item of r.raise) lines.push(`  raise: ${item}`);
  for (const note of r.notes) lines.push(`  note: ${note}`);
  return lines.join('\n');
}

// The project's own verify skill: how to start the real app and prove a
// feature. It records the code it covers and the commit it was last confirmed
// at, so we can tell when it has fallen behind the code.
export function verifySkillStatus(cwd) {
  const seen = new Set();
  for (const root of ['.claude/skills', '.agents/skills', '.codex/skills']) {
    const dir = join(cwd, root);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.startsWith('verify-')).sort()) {
      const file = join(dir, name, 'SKILL.md');
      if (!existsSync(file)) continue;
      const real = realpathSync(file);
      if (seen.has(real)) continue;
      seen.add(real);
      const meta = parseFrontmatter(readFileSync(real, 'utf8'));
      const base = { name: meta.name || name, path: real, sync: meta.sync || null };
      if (!meta.sync || !meta.covers) return { ...base, state: 'unsynced', changed: [], reason: 'its frontmatter has no covers and sync lines' };
      const globs = meta.covers.split(',').map((g) => globToRegExp(g.trim()));
      try {
        const changed = git(cwd, 'diff', '--name-only', meta.sync, 'HEAD').split('\n').filter((p) => p && globs.some((g) => g.test(p)));
        return { ...base, state: changed.length ? 'stale' : 'current', changed };
      } catch {
        return { ...base, state: 'unsynced', changed: [], reason: `sync commit ${meta.sync} is not in this repository` };
      }
    }
  }
  return { state: 'missing', changed: [] };
}

export function renderVerifySkill(s) {
  if (s.state === 'missing') return 'verify skill: missing. This project has no scripted way to prove behaviour end to end. Create one with /orch-verify.';
  if (s.state === 'unsynced') return `verify skill: ${s.name} is unsynced (${s.reason}). Run /orch-verify to confirm it.`;
  if (s.state === 'stale') return `verify skill: ${s.name} is stale. ${s.changed.length} covered file(s) changed since ${s.sync.slice(0, 10)}: ${s.changed.slice(0, 6).join(', ')}${s.changed.length > 6 ? ', …' : ''}. Run /orch-verify to bring it back in line.`;
  return `verify skill: ${s.name} is current (confirmed at ${s.sync.slice(0, 10)}).`;
}

export function validateAcceptance(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) return ['acceptance must be an array'];
  const errors = [];
  const ids = new Set();
  for (const [i, c] of list.entries()) {
    const at = `acceptance[${i}]${c?.id ? ` (${c.id})` : ''}`;
    if (!c?.id || !/^[a-zA-Z0-9_-]+$/.test(c.id)) errors.push(`${at}: id must match [a-zA-Z0-9_-]+`);
    if (ids.has(c?.id)) errors.push(`${at}: duplicate id`);
    ids.add(c?.id);
    if (!c?.criterion) errors.push(`${at}: criterion is required, one sentence a reviewer can judge`);
    if (!c?.check && !c?.manual) errors.push(`${at}: needs a check command, or manual saying what a person must look at`);
    if (c?.check && c?.manual) errors.push(`${at}: use check or manual, not both`);
    if (c?.proveOn && (!Array.isArray(c.proveOn) || !c.check)) errors.push(`${at}: proveOn is a list of files and needs a check`);
    if (c?.confidence != null && !isPercent(c.confidence)) errors.push(`${at}: confidence must be a number from 0 to 100`);
    if (c?.kind != null && !(c.kind in KIND_CAPS)) errors.push(`${at}: kind must be one of ${Object.keys(KIND_CAPS).join(', ')}`);
  }
  return errors;
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

export function defaultBase(cwd) {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master']) {
    try {
      return git(cwd, 'merge-base', 'HEAD', ref);
    } catch {}
  }
  throw new Error('Cannot find the base commit. Pass --base <ref>.');
}

// A check proves something only if it can fail. Run it on the base commit,
// with just the files that hold the check copied over, and expect a failure.
export async function proveCanFail(criterion, { cwd, base, sh = runVerify }) {
  const dir = join(cwd, '.orch', 'prove', criterion.id);
  try {
    git(cwd, 'worktree', 'remove', '--force', dir);
  } catch {}
  mkdirSync(dirname(dir), { recursive: true });
  git(cwd, 'worktree', 'add', '--detach', dir, base);
  try {
    for (const file of criterion.proveOn) {
      if (!existsSync(join(cwd, file))) return { failedOnBase: null, output: `proveOn file not found: ${file}` };
      cpSync(join(cwd, file), join(dir, file), { recursive: true });
    }
    for (const name of LINK_DIRS) {
      if (existsSync(join(cwd, name)) && !existsSync(join(dir, name))) symlinkSync(join(cwd, name), join(dir, name));
    }
    const result = await sh(criterion.check, dir);
    return { failedOnBase: !result.passed, output: result.output };
  } finally {
    try {
      git(cwd, 'worktree', 'remove', '--force', dir);
    } catch {}
  }
}

// --- Keeping the checks out of reach of the change they judge ---------------

// The criteria are frozen when the run starts. Changing them afterwards is the
// user's call, never the agent's.
const lockPath = (cwd) => join(cwd, '.orch', 'acceptance.lock.json');
const canonical = (plan) => JSON.stringify(plan.acceptance ?? []);

export function lockAcceptance(plan, cwd) {
  mkdirSync(join(cwd, '.orch'), { recursive: true });
  writeFileSync(join(cwd, '.orch', '.gitignore'), '*\n');
  writeFileSync(lockPath(cwd), canonical(plan));
}

export function acceptanceChanged(plan, cwd) {
  return existsSync(lockPath(cwd)) && readFileSync(lockPath(cwd), 'utf8') !== canonical(plan);
}

const TEST_FILE = /(^|\/)(tests?|__tests__|specs?|e2e)\/|\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|(^|\/)test_[^/]+\.py$/;

// Files this change touches, with git's status letter, compared to the base.
export function changedFiles(cwd, base) {
  return git(cwd, 'diff', '--name-status', base)
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...paths] = line.split('\t');
      return { status: status[0], path: paths[paths.length - 1] };
    });
}

export function globToRegExp(glob) {
  const body = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  return new RegExp(`^${body}$`);
}

export const STANDING_FILE = 'orch.checks.json';

// Project checks, written by the people who own the code. Each has a trigger
// readable from the diff. They are read from the base commit, so a change
// cannot edit the checks that judge it.
export function standingChecks(cwd, base, files) {
  let raw;
  try {
    raw = git(cwd, 'show', `${base}:${STANDING_FILE}`);
  } catch {
    return [];
  }
  const list = JSON.parse(raw);
  const paths = files.map((f) => f.path);
  return list
    .filter((item) => (item.when ?? ['**']).some((g) => paths.some((p) => globToRegExp(g).test(p))))
    .map((item) => ({ id: item.id, criterion: item.why ?? item.id, check: item.check, manual: item.ask, standing: true }));
}

export async function runAcceptance(plan, { cwd, prove = false, repeat = 1, base, sh = runVerify, proveImpl = proveCanFail, diff = changedFiles, standing = standingChecks } = {}) {
  const list = plan.acceptance ?? [];
  if (!list.length) throw new Error('This plan defines no acceptance criteria. Every PR needs them: add an "acceptance" list to the plan.');
  const errors = validateAcceptance(list);
  if (errors.length) throw new Error(`Invalid acceptance criteria:\n  - ${errors.join('\n  - ')}`);

  // What the diff itself calls for: project checks whose trigger matches, and
  // a person's look whenever the change rewrites tests that already existed.
  const flags = [];
  let projectChecks = [];
  try {
    const baseRef = base ?? defaultBase(cwd);
    const files = diff(cwd, baseRef);
    projectChecks = standing(cwd, baseRef, files);
    const edited = files.filter((f) => f.status !== 'A' && TEST_FILE.test(f.path)).map((f) => f.path);
    if (edited.length) flags.push(`This change edits or removes tests that already existed: ${edited.join(', ')}. A person should confirm that is intended.`);
    if (files.some((f) => f.path === STANDING_FILE)) flags.push(`This change edits ${STANDING_FILE}. The project checks applied here are the ones from before the change.`);
  } catch {}

  const criteria = [];
  for (const c of [...list, ...projectChecks]) {
    if (c.manual) {
      criteria.push({ id: c.id, criterion: c.criterion, type: 'manual', manual: c.manual, status: 'needs_human', standing: c.standing });
      continue;
    }
    const run = await sh(c.check, cwd);
    const row = { id: c.id, criterion: c.criterion, type: 'check', kind: c.kind, check: c.check, status: run.passed ? 'pass' : 'fail', output: run.output, standing: c.standing };
    // A check that passes once and fails the next time is telling you nothing.
    for (let i = 1; i < repeat && row.status === 'pass'; i++) {
      const again = await sh(c.check, cwd);
      if (!again.passed) Object.assign(row, { status: 'fail', reason: 'flaky: it passed, then failed when run again', output: again.output });
    }
    // proveOn: [] means the check needs no new files: run it as it is on the old code.
    if (row.status === 'pass' && prove && Array.isArray(c.proveOn)) {
      const proof = await proveImpl(c, { cwd, base: base ?? defaultBase(cwd), sh });
      row.proof = proof;
      // Passing on the old code too means the check does not test this change.
      if (proof.failedOnBase === false) Object.assign(row, { status: 'fail', reason: 'the check also passes without the change, so it proves nothing' });
      if (proof.failedOnBase === null) Object.assign(row, { status: 'fail', reason: proof.output });
    }
    criteria.push(row);
  }

  const verdict = criteria.some((c) => c.status === 'fail') ? 'fail' : criteria.some((c) => c.status === 'needs_human') || flags.length ? 'needs_human' : 'pass';
  let head = null;
  try {
    head = git(cwd, 'rev-parse', 'HEAD');
  } catch {}
  let dirty = false;
  try {
    dirty = git(cwd, 'status', '--porcelain', '--untracked-files=no') !== '';
  } catch {}
  return { verdict, head, dirty, at: new Date().toISOString(), goal: plan.goal ?? '', source: plan.source ?? null, readiness: readiness(plan), flags, criteria };
}

// --- Independent verdicts -----------------------------------------------------
// A session that did not write the code runs the change the way a user would
// and records what it saw. The verdict is tied to the patch, not the commit, so
// a rebase that leaves the change itself untouched does not void it.
export const VERDICTS = ['PASS', 'PASS+NOTES', 'FAIL', 'INCONCLUSIVE'];

export function patchId(cwd, base) {
  const diff = execFileSync('git', ['diff', `${base}...HEAD`], { cwd, maxBuffer: 256 * 1024 * 1024 });
  if (!diff.length) return null;
  return execFileSync('git', ['patch-id', '--stable'], { cwd, input: diff }).toString().split(' ')[0] || null;
}

// Every model that wrote code in this checkout's runs.
export function authorsOf(cwd) {
  const dir = join(cwd, '.orch', 'runs');
  const authors = new Set();
  if (!existsSync(dir)) return [];
  for (const run of readdirSync(dir)) {
    try {
      const { plan } = JSON.parse(readFileSync(join(dir, run, 'plan.json'), 'utf8'));
      const state = JSON.parse(readFileSync(join(dir, run, 'state.json'), 'utf8'));
      const writers = new Set(plan.tasks.filter((t) => t.mode === 'write').map((t) => t.id));
      for (const t of state.tasks) if (writers.has(t.id) && t.model) authors.add(t.model.split('@')[0]);
    } catch {}
  }
  return [...authors];
}

export function recordVerdict(cwd, { result, by, notes = '', base }) {
  if (!VERDICTS.includes(result)) throw new Error(`Verdict must be one of ${VERDICTS.join(', ')}`);
  if (!by) throw new Error('Say who produced the verdict: --by <agent/model>, for example --by codex/default');
  const verdict = { result, by, notes, head: git(cwd, 'rev-parse', 'HEAD'), patchId: patchId(cwd, base ?? defaultBase(cwd)), at: new Date().toISOString() };
  mkdirSync(join(cwd, '.orch'), { recursive: true });
  writeFileSync(join(cwd, '.orch', 'verdict.json'), JSON.stringify(verdict, null, 2));
  return verdict;
}

export function loadVerdict(cwd) {
  const path = join(cwd, '.orch', 'verdict.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

// Does a recorded verdict count? Returns { ok, reason }.
export function judgeVerdict(verdict, { authors, currentPatchId }) {
  if (!verdict) return { ok: false, reason: 'No independent verdict: nobody but the author has run this change' };
  if (authors.includes(verdict.by.split('@')[0])) return { ok: false, reason: `The verdict is from ${verdict.by}, which also wrote the code. An author checks what it meant to build` };
  if (verdict.patchId && currentPatchId && verdict.patchId !== currentPatchId) return { ok: false, reason: 'The change has been edited since the verdict was given. Verify it again' };
  if (verdict.result === 'INCONCLUSIVE') return { ok: false, reason: `Independent verification was inconclusive: ${verdict.notes || 'no reason given'}` };
  if (verdict.result === 'FAIL') return { ok: false, failed: true, reason: `Independent verification failed: ${verdict.notes || 'no reason given'}` };
  return { ok: true, reason: `Independent verdict ${verdict.result} from ${verdict.by}` };
}

const ICON = { pass: '✅', fail: '❌', needs_human: '👀' };
const VERDICT = { pass: 'PASSED', fail: 'FAILED', needs_human: 'NEEDS A HUMAN' };

export function renderReport(r) {
  const lines = [`## Verification: ${VERDICT[r.verdict]}`, ''];
  if (r.head) lines.push(`Checked at \`${r.head.slice(0, 10)}\`${r.dirty ? ' with uncommitted changes' : ''}.`, '');
  if (r.readiness) lines.push(`Plan confidence before starting: ${r.readiness.score}/100 (understanding ${r.readiness.understanding}, verification ${r.readiness.verification}).`, '');
  for (const flag of r.flags ?? []) lines.push(`👀 ${flag}`, '');
  lines.push('| | Criterion | How it was checked |', '|---|---|---|');
  for (const c of r.criteria) {
    const how = c.type === 'manual' ? `Human: ${c.manual}` : `${c.kind ? `${c.kind}: ` : ''}\`${c.check}\`${c.proof?.failedOnBase ? ' (seen failing before the change)' : ''}${c.reason ? `<br>${c.reason}` : ''}`;
    lines.push(`| ${ICON[c.status]} | ${c.criterion}${c.standing ? ' *(project check)*' : ''} | ${how.replace(/\|/g, '\\|')} |`);
  }
  const tail = (text) => String(text ?? '').trim().split('\n').slice(-25).join('\n');
  for (const c of r.criteria) {
    if (c.type !== 'check' || !c.output?.trim()) continue;
    const before = c.proof?.failedOnBase && c.proof.output?.trim() ? ['**Before the change** (the check fails):', '', '```', tail(c.proof.output), '```', '', '**After:**', ''] : [];
    lines.push('', `<details><summary>${c.id}: evidence</summary>`, '', ...before, '```', tail(c.output), '```', '</details>');
  }
  return `${lines.join('\n')}\n`;
}

export function saveReport(result, cwd) {
  const dir = join(cwd, '.orch');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.gitignore'), '*\n');
  writeFileSync(join(dir, 'verification.json'), JSON.stringify(result, null, 2));
  writeFileSync(join(dir, 'verification.md'), renderReport(result));
  return { json: join(dir, 'verification.json'), md: join(dir, 'verification.md') };
}

export function loadReport(cwd) {
  const path = join(cwd, '.orch', 'verification.json');
  if (!existsSync(path)) throw new Error('No verification result. Run `orch verify <plan.json>` first.');
  return JSON.parse(readFileSync(path, 'utf8'));
}
