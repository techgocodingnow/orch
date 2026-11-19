import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODELS } from '../src/catalog.mjs';
import { route, validatePlan } from '../src/router.mjs';
import { run, runVerify } from '../src/runner.mjs';
import { parseIssueRef, findIssueRef, adfToText, getIssue, renderIssue } from '../src/jira.mjs';
import { summarize, feedback, resolvePr } from '../src/pr.mjs';
import { notify } from '../src/notify.mjs';
import { connectorState } from '../src/setup.mjs';

const config = { models: DEFAULT_MODELS, concurrency: 4, timeoutMinutes: 1, escalate: true };
const agents = ['claude', 'codex'];
const t = (id, o = {}) => ({ id, kind: 'implement', complexity: 'S', mode: 'write', prompt: `do ${id}`, ...o });
const go = (plan, opts) => run(plan, route(plan, { models: DEFAULT_MODELS, agents, profile: 'balanced' }), { cwd: mkdtempSync(join(tmpdir(), 'orch-')), config, agents, ...opts });
const okInvoke = async () => ({ ok: true, text: 'report', usd: 0.01, durationMs: 1 });

test('a human task is raised, its dependents wait, the rest runs', async () => {
  const plan = { goal: 'g', tasks: [{ id: 'ask', title: 'Pick the limit', needsHuman: 'Need the limit from product.' }, t('blocked', { deps: ['ask'] }), t('free')] };
  assert.deepEqual(validatePlan(plan), []);
  const routed = route(plan, { models: DEFAULT_MODELS, agents });
  assert.equal(routed.tasks[0].assignment, null);
  const s = await go(plan, { invoke: okInvoke, verifyCommand: async () => ({ passed: true, output: '' }) });
  assert.deepEqual(Object.fromEntries(s.tasks.map((x) => [x.id, x.status])), { ask: 'needs_human', blocked: 'skipped', free: 'done' });
  assert.deepEqual(s.needsHuman, [{ id: 'ask', reason: 'Need the limit from product.' }]);
  assert.equal(s.ok, false);
});

test('a failing check sends the output back to a worker until it passes', async () => {
  const prompts = [];
  let checks = 0;
  const s = await go({ goal: 'g', verify: 'npm test', tasks: [t('a')] }, {
    invoke: async ({ prompt }) => { prompts.push(prompt); return { ok: true, text: `report ${prompts.length}`, usd: 0.01, durationMs: 1 }; },
    verifyCommand: async (cmd) => { assert.equal(cmd, 'npm test'); return ++checks < 2 ? { passed: false, output: 'AssertionError: 1 !== 2' } : { passed: true, output: '' }; },
  });
  assert.equal(s.tasks[0].status, 'done');
  assert.deepEqual(s.tasks[0].verify, { command: 'npm test', passed: true, rounds: 1 });
  assert.match(prompts[0], /accepted only when this command exits 0/);
  assert.match(prompts[1], /AssertionError: 1 !== 2/);
  assert.match(prompts[1], /report 1/);
  assert.equal(s.spentUsd, 0.02);
});

test('a check that never passes fails the task after three fix rounds, escalating the model', async () => {
  const models = [];
  const s = await go({ goal: 'g', tasks: [t('a', { verify: 'false' }), t('b', { deps: ['a'] })] }, {
    invoke: async ({ assignment }) => { models.push(assignment.id); return { ok: true, text: 'r', usd: 0, durationMs: 1 }; },
    verifyCommand: async () => ({ passed: false, output: 'nope' }),
  });
  assert.equal(s.tasks[0].status, 'failed');
  assert.match(s.tasks[0].error, /check still failing/);
  assert.equal(s.tasks[1].status, 'skipped');
  assert.equal(models.length, 4);
  assert.notEqual(models[3], models[0]);
});

test('read tasks are not checked by the plan-level command; runVerify reports exit status', async () => {
  let checked = 0;
  await go({ goal: 'g', verify: 'npm test', tasks: [t('r', { mode: 'read', kind: 'explore' })] }, { invoke: okInvoke, verifyCommand: async () => { checked++; return { passed: true, output: '' }; } });
  assert.equal(checked, 0);
  assert.equal((await runVerify('echo hi && exit 0', tmpdir())).passed, true);
  const bad = await runVerify('echo broken >&2; exit 3', tmpdir());
  assert.equal(bad.passed, false);
  assert.match(bad.output, /broken/);
});

test('jira: issue refs from keys, URLs and free text', () => {
  assert.deepEqual(parseIssueRef('PROJ-123'), { key: 'PROJ-123' });
  assert.deepEqual(parseIssueRef('https://acme.atlassian.net/browse/AB2-9?focus=1'), { key: 'AB2-9', baseUrl: 'https://acme.atlassian.net' });
  assert.equal(parseIssueRef('fix the bug'), null);
  assert.deepEqual(findIssueRef('--budget 2 PROJ-7, please'), { key: 'PROJ-7' });
  assert.equal(findIssueRef('add rate limiting'), null);
});

test('jira: ADF becomes readable text and an issue renders', async () => {
  const adf = { type: 'doc', content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance' }] },
    { type: 'bulletList', content: [
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'returns ' }, { type: 'text', text: '429', marks: [{ type: 'code' }] }] }] },
      { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'docs', marks: [{ type: 'link', attrs: { href: 'https://x.y' } }] }] }] },
    ] },
    { type: 'codeBlock', attrs: { language: 'js' }, content: [{ type: 'text', text: 'limit(10)' }] },
  ] };
  assert.equal(adfToText(adf), '## Acceptance\n\n- returns `429`\n- [docs](https://x.y)\n\n```js\nlimit(10)\n```');
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([url, init.headers.Authorization]); return { ok: true, status: 200, json: async () => ({ key: 'PROJ-1', fields: { summary: 'Add limiter', description: adf, issuetype: { name: 'Story' }, status: { name: 'To Do' }, comment: { comments: [{ author: { displayName: 'Ann' }, created: '2026-01-02T00:00:00Z', body: adf }] } } }) }; };
  const issue = await getIssue({ key: 'PROJ-1' }, { baseUrl: 'https://acme.atlassian.net', email: 'a@b.c', token: 'tok' }, { fetchImpl });
  assert.match(calls[0][0], /^https:\/\/acme\.atlassian\.net\/rest\/api\/3\/issue\/PROJ-1\?fields=/);
  assert.equal(calls[0][1], `Basic ${Buffer.from('a@b.c:tok').toString('base64')}`);
  const text = renderIssue(issue);
  assert.match(text, /# PROJ-1: Add limiter/);
  assert.match(text, /\*\*Ann\*\* \(2026-01-02\)/);
  await assert.rejects(getIssue({ key: 'PROJ-1' }, { baseUrl: '', email: '', token: '' }), /Missing JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN/);
});

const prFixture = (over = {}) => ({
  number: 7, url: 'u', state: 'OPEN', headRefName: 'b', reviewDecision: null, author: { login: 'me' },
  commits: { nodes: [{ commit: { oid: 'abc', committedDate: '2026-01-10T00:00:00Z', statusCheckRollup: { contexts: { nodes: [] } } } }] },
  reviewThreads: { nodes: [] }, reviews: { nodes: [] }, comments: { nodes: [] }, ...over,
});
const c = (login, body, createdAt = '2026-01-11T00:00:00Z', typename = 'User') => ({ author: { login, __typename: typename }, body, createdAt, url: 'cu' });

test('pr: only unanswered, current feedback is listed', () => {
  const f = summarize(prFixture({
    reviewThreads: { nodes: [
      { id: 'T1', isResolved: false, isOutdated: false, path: 'a.js', line: 3, comments: { nodes: [c('cursor[bot]', 'Bug: off by one', undefined, 'Bot')] } },
      { id: 'T2', isResolved: true, isOutdated: false, path: 'a.js', line: 9, comments: { nodes: [c('ann', 'nit')] } },
      { id: 'T3', isResolved: false, isOutdated: false, path: 'b.js', line: 1, comments: { nodes: [c('ann', 'why?'), c('me', 'because')] } },
    ] },
    reviews: { nodes: [
      { author: { login: 'ann' }, state: 'CHANGES_REQUESTED', body: '', submittedAt: '2026-01-11T00:00:00Z', url: 'r1' },
      { author: { login: 'ann' }, state: 'COMMENTED', body: '', submittedAt: '2026-01-11T00:00:00Z', url: 'r2' },
      { author: { login: 'bob' }, state: 'COMMENTED', body: 'old remark', submittedAt: '2026-01-09T00:00:00Z', url: 'r3' },
    ] },
    comments: { nodes: [c('me', 'my own note'), c('bugbot[bot]', 'Found 1 issue', undefined, 'Bot'), c('ann', 'stale', '2026-01-01T00:00:00Z')] },
    commits: { nodes: [{ commit: { oid: 'abc', committedDate: '2026-01-10T00:00:00Z', statusCheckRollup: { contexts: { nodes: [
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'd' },
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'Cursor Bugbot', status: 'IN_PROGRESS', conclusion: null },
    ] } } } }] },
  }));
  assert.deepEqual(f.items.map((i) => [i.type, i.id ?? i.state ?? i.name ?? i.author]), [['thread', 'T1'], ['review', 'CHANGES_REQUESTED'], ['comment', 'bugbot[bot]'], ['check', 'test']]);
  assert.equal(f.items[0].bot, true);
  assert.equal(f.pendingChecks, 1);
  assert.equal(f.clean, false);
  assert.equal(summarize(prFixture()).clean, true);
});

test('pr: feedback waits for pending checks, and PR refs resolve', async () => {
  let calls = 0;
  const pending = { __typename: 'CheckRun', name: 'ci', status: 'QUEUED', conclusion: null };
  const gh = async () => {
    calls++;
    const nodes = calls < 3 ? [pending] : [];
    return JSON.stringify({ data: { repository: { pullRequest: prFixture({ commits: { nodes: [{ commit: { oid: 'a', committedDate: '2026-01-10T00:00:00Z', statusCheckRollup: { contexts: { nodes } } } }] } }) } } });
  };
  const f = await feedback({ owner: 'o', repo: 'r', number: 7 }, { gh, waitMinutes: 1, sleep: async () => {} });
  assert.equal(calls, 3);
  assert.equal(f.clean, true);
  assert.deepEqual(await resolvePr('https://github.com/o/r/pull/12'), { owner: 'o', repo: 'r', number: 12 });
  assert.deepEqual(await resolvePr('#5', 'o/r'), { owner: 'o', repo: 'r', number: 5 });
  await assert.rejects(resolvePr('abc'), /PR number or URL/);
});

test('notify: sends to each channel that is on', async () => {
  const posts = [];
  const fetchImpl = async (url, init) => { posts.push([url, JSON.parse(init.body).text]); return { ok: true }; };
  const sent = await notify('PR ready', { title: 'PROJ-1', settings: { desktop: true, webhook: 'https://hook' }, fetchImpl, desktopImpl: async () => true });
  assert.deepEqual(sent, ['desktop', 'webhook']);
  assert.deepEqual(posts, [['https://hook', '*PROJ-1*\nPR ready']]);
  assert.deepEqual(await notify('x', { settings: { desktop: false, webhook: null } }), []);
});

test('setup: reads the Atlassian connector state from each agent', () => {
  assert.equal(connectorState('claude', 'claude.ai Atlassian: https://mcp.atlassian.com/v2/mcp - ! Needs authentication'), 'needs-login');
  assert.equal(connectorState('claude', 'claude.ai Atlassian: https://mcp.atlassian.com/v2/mcp - ✔ Connected'), 'connected');
  assert.equal(connectorState('claude', 'sentry: https://x - ✔ Connected'), 'missing');
  assert.equal(connectorState('codex', 'Name  Url\natlassian  https://mcp.atlassian.com/v1/mcp'), 'connected');
  assert.equal(connectorState('codex', 'Name\nnode_repl', '[plugins."jira@openai-curated"]\nenabled = true\n'), 'connected');
  assert.equal(connectorState('codex', 'Name\nnode_repl', '[plugins."slack@openai-curated"]\nenabled = true\n'), 'missing');
});

test('roles pin a kind to a model, and a task pin still wins', () => {
  const plan = { tasks: [t('a', { kind: 'review', mode: 'read' }), t('b', { kind: 'review', mode: 'read', model: 'claude/haiku@low' }), t('c')] };
  const r = route(plan, { models: DEFAULT_MODELS, agents, roles: { review: 'claude/fable' }, budget: 0.01 });
  assert.equal(r.tasks[0].assignment.modelId, 'claude/fable');
  assert.equal(r.tasks[1].assignment.id, 'claude/haiku@low');
  assert.notEqual(r.tasks[2].assignment.modelId, 'claude/fable');
});

test('transcripts: only what the user typed, in this project, from both agents', async () => {
  const { collect, render } = await import('../src/transcripts.mjs');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'orch-home-'));
  const now = new Date().toISOString();
  const jl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');
  mkdirSync(join(home, '.claude/projects/-work-app'), { recursive: true });
  mkdirSync(join(home, '.claude/projects/-work-other'), { recursive: true });
  writeFileSync(join(home, '.claude/projects/-work-app/s1.jsonl'), jl([
    { type: 'user', sessionId: 's1', cwd: '/work/app', timestamp: now, message: { content: [{ type: 'text', text: 'fix the login bug <system-reminder>noise</system-reminder>' }] } },
    { type: 'user', sessionId: 's1', timestamp: now, toolUseResult: {}, message: { content: [{ type: 'tool_result', content: 'x' }] } },
    { type: 'user', sessionId: 's1', timestamp: now, isSidechain: true, message: { content: 'subagent prompt' } },
    { type: 'user', sessionId: 's1', timestamp: now, message: { content: '<command-name>/clear</command-name>' } },
    { type: 'assistant', sessionId: 's1', timestamp: now, message: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'user', sessionId: 's1', cwd: '/work/app', timestamp: now, message: { content: 'no, do not commit yet' } },
  ]));
  writeFileSync(join(home, '.claude/projects/-work-other/s2.jsonl'), jl([{ type: 'user', sessionId: 's2', timestamp: now, message: { content: 'private elsewhere' } }]));
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = join(home, '.codex');
  mkdirSync(join(home, '.codex/sessions/2026/01'), { recursive: true });
  const user = (text) => ({ type: 'response_item', timestamp: now, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  writeFileSync(join(home, '.codex/sessions/2026/01/a.jsonl'), jl([{ type: 'session_meta', payload: { id: 'c1', cwd: '/work/app', originator: 'Codex Desktop' } }, user('# AGENTS.md instructions'), user('add tests first')]));
  writeFileSync(join(home, '.codex/sessions/2026/01/b.jsonl'), jl([{ type: 'session_meta', payload: { id: 'c2', cwd: '/work/app', originator: 'codex_exec' } }, user('worker prompt')]));
  try {
    const mine = collect({ cwd: '/work/app', home });
    assert.deepEqual(mine.map((m) => m.text).sort(), ['add tests first', 'fix the login bug', 'no, do not commit yet']);
    assert.equal(collect({ cwd: '/work/app', home, all: true }).length, 4);
    assert.match(render(mine), /=== (claude|codex) · /);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});

test('acceptance: shape is validated with the plan', async () => {
  const { validateAcceptance } = await import('../src/verify.mjs');
  assert.deepEqual(validateAcceptance([{ id: 'a', criterion: 'works', check: 'true' }, { id: 'b', criterion: 'reads well', manual: 'read it' }]), []);
  const errs = validateAcceptance([{ id: 'a', criterion: 'x' }, { id: 'a', criterion: 'y', check: 'true', manual: 'z' }, { id: 'c', check: 'true' }]);
  assert.equal(errs.length, 4);
  assert.match(validatePlan({ tasks: [t('x')], acceptance: [{ id: 'a' }] }).join(' '), /criterion is required/);
});

test('acceptance: verdict is fail, needs_human or pass, and a check that cannot fail does not count', async () => {
  const { runAcceptance, renderReport } = await import('../src/verify.mjs');
  const cwd = mkdtempSync(join(tmpdir(), 'orch-v-'));
  const sh = async (cmd) => ({ passed: cmd !== 'bad', output: `ran ${cmd}` });
  const run = (acceptance, extra = {}) => runAcceptance({ acceptance }, { cwd, sh, diff: () => [], standing: () => [], ...extra });
  const chk = (id, check, o = {}) => ({ id, criterion: `${id} holds`, check, ...o });
  assert.equal((await run([chk('a', 'ok')])).verdict, 'pass');
  assert.equal((await run([chk('a', 'ok'), { id: 'm', criterion: 'reads well', manual: 'read it' }])).verdict, 'needs_human');
  assert.equal((await run([chk('a', 'bad'), { id: 'm', criterion: 'reads well', manual: 'read it' }])).verdict, 'fail');
  await assert.rejects(run([]), /defines no acceptance criteria/);

  const proved = await run([chk('a', 'ok', { proveOn: ['t.js'] })], { prove: true, base: 'b', proveImpl: async () => ({ failedOnBase: true, output: 'boom' }) });
  assert.equal(proved.verdict, 'pass');
  assert.match(renderReport(proved), /PASSED[\s\S]*seen failing before the change/);
  const hollow = await run([chk('a', 'ok', { proveOn: ['t.js'] })], { prove: true, base: 'b', proveImpl: async () => ({ failedOnBase: false, output: '' }) });
  assert.equal(hollow.verdict, 'fail');
  assert.match(hollow.criteria[0].reason, /proves nothing/);
  let proofs = 0;
  await run([chk('a', 'ok', { proveOn: ['t.js'] })], { proveImpl: async () => { proofs++; return { failedOnBase: true }; } });
  assert.equal(proofs, 0);
});

test('gate: status follows the verdict, the reviews and the commit; auto-merge only on success', async () => {
  const { decide, gate, summarize: sum } = await import('../src/pr.mjs');
  const v = (verdict, o = {}) => ({ verdict, head: 'abc', dirty: false, criteria: [{ id: 'a', status: verdict === 'fail' ? 'fail' : 'pass' }, ...(verdict === 'needs_human' ? [{ id: 'm', status: 'needs_human' }] : [])], ...o });
  const fb = (o = {}) => ({ head: 'abc', pendingChecks: 0, items: [], ...o });
  assert.equal(decide(v('pass'), fb()).state, 'success');
  assert.equal(decide(v('fail'), fb()).state, 'failure');
  assert.equal(decide(v('needs_human'), fb()).state, 'pending');
  assert.equal(decide(v('pass'), fb({ items: [{ type: 'check', name: 'ci' }] })).state, 'failure');
  assert.equal(decide(v('pass'), fb({ items: [{ type: 'thread' }] })).state, 'pending');
  assert.equal(decide(v('pass'), fb({ pendingChecks: 1 })).state, 'pending');
  assert.match(decide(v('pass'), fb({ head: 'zzz' })).description, /different commit/);
  assert.equal(decide(v('pass', { dirty: true }), fb()).state, 'pending');

  // our own status must not come back as feedback
  const own = sum(prFixture({ commits: { nodes: [{ commit: { oid: 'abc', committedDate: '2026-01-10T00:00:00Z', statusCheckRollup: { contexts: { nodes: [{ __typename: 'StatusContext', context: 'orch/verification', state: 'FAILURE' }] } } } }] } }));
  assert.equal(own.clean, true);

  const mk = () => { const calls = []; return { calls, gh: async (args) => { calls.push(args); return args[1] === 'graphql' ? JSON.stringify({ data: { repository: { pullRequest: prFixture() } } }) : '{}'; } }; };
  const target = { owner: 'o', repo: 'r', number: 7 };
  const human = mk();
  const r1 = await gate(target, v('pass'), 'REPORT', { approve: 'human', gh: human.gh });
  assert.equal(r1.state, 'success');
  assert.ok(human.calls.some((a) => a[1] === 'repos/o/r/statuses/abc' && a.includes('state=success') && a.includes('context=orch/verification')));
  assert.ok(human.calls.some((a) => a[0] === 'pr' && a[1] === 'comment'));
  assert.ok(!human.calls.some((a) => a[1] === 'merge'));
  const auto = mk();
  const r2 = await gate(target, v('pass'), 'REPORT', { approve: 'auto', gh: auto.gh });
  assert.deepEqual(auto.calls.find((a) => a[1] === 'merge'), ['pr', 'merge', '7', '--repo', 'o/r', '--auto', '--squash', '--match-head-commit', 'abc']);
  assert.equal(r2.approval, 'auto-merge enabled');
  const blocked = mk();
  await gate(target, v('needs_human'), 'REPORT', { approve: 'auto', gh: blocked.gh });
  assert.ok(!blocked.calls.some((a) => a[1] === 'merge'));
});

test('confidence: a solid plan starts alone, a weak point or anything unrated is raised', async () => {
  const { readiness } = await import('../src/verify.mjs');
  const crit = (id, confidence, o = {}) => ({ id, criterion: id, check: 'true', kind: 'e2e', confidence, ...o });
  const plan = (o) => ({ confidence: { understanding: 90, assumptions: ['limit is per user'] }, acceptance: [crit('a', 90), crit('b', 80)], tasks: [], ...o });

  const good = readiness(plan({}));
  assert.equal(good.decision, 'start');
  assert.equal(good.score, Math.round(0.4 * 90 + 0.6 * (0.5 * 85 + 0.5 * 80)));
  assert.deepEqual(good.raise, []);
  assert.deepEqual(good.notes, ['Assumed: limit is per user']);

  // one hollow check drags the score and is named, with the assumptions turned into questions
  const hollow = readiness(plan({ acceptance: [crit('a', 95), crit('b', 40, { why: 'only greps the source' })] }));
  assert.equal(hollow.decision, 'raise');
  assert.ok(hollow.raise.some((r) => /"b": only 40% sure.*only greps the source/.test(r)));
  assert.ok(hollow.raise.includes('Assumed, please confirm: limit is per user'));

  assert.equal(readiness(plan({ confidence: { understanding: 45, why: 'ticket is one line' } })).decision, 'raise');
  // a middling item alone does not hold the run; it is flagged
  const middling = readiness(plan({ acceptance: [crit('a', 95), crit('b', 60)] }));
  assert.equal(middling.decision, 'start');
  assert.ok(middling.notes.some((n) => /^Weak: Criterion "b": only 60%/.test(n)));
  // several middling items pull the score under the bar, and then all are raised
  const many = readiness(plan({ confidence: { understanding: 60 }, acceptance: [crit('a', 60), crit('b', 55)] }));
  assert.equal(many.decision, 'raise');
  assert.equal(many.raise.length, 3);
  assert.match(readiness(plan({ confidence: undefined })).raise[0], /does not rate/);
  assert.match(readiness(plan({ acceptance: [{ id: 'a', criterion: 'a', check: 'true' }] })).raise.join(' '), /no confidence rating/);
  assert.match(readiness(plan({ acceptance: [] })).raise.join(' '), /no acceptance criteria/);
  assert.match(readiness(plan({ acceptance: [{ id: 'm', criterion: 'm', manual: 'look' }] })).raise.join(' '), /every one needs a person/);

  // a manual criterion and a human task do not block starting; they are noted
  const mixed = readiness(plan({ acceptance: [crit('a', 90), { id: 'm', criterion: 'm', manual: 'read the copy' }], tasks: [{ id: 'h', needsHuman: 'pick the limit' }] }));
  assert.equal(mixed.decision, 'start');
  assert.equal(mixed.notes.length, 3);
  assert.equal(readiness(plan({}), 95).decision, 'raise');
  assert.match(validatePlan({ tasks: [t('x')], confidence: { understanding: 140 } }).join(' '), /0 to 100/);
});

test('a check kind caps how far a pass can be trusted', async () => {
  const { readiness, effectiveConfidence, validateAcceptance } = await import('../src/verify.mjs');
  const c = (kind, confidence) => ({ id: 'a', criterion: 'a', check: 'true', kind, confidence });
  assert.equal(effectiveConfidence(c('e2e', 95)), 95);
  assert.equal(effectiveConfidence(c('unit', 95)), 80);
  assert.equal(effectiveConfidence(c('static', 95)), 60);
  assert.equal(effectiveConfidence(c(undefined, 95)), 60);
  const r = readiness({ confidence: { understanding: 95 }, acceptance: [c('static', 99)] });
  assert.equal(r.verification, 60);
  assert.match(r.notes.join(' '), /rated 99, capped: a static check/);
  assert.match(validateAcceptance([c('vibes', 50)]).join(' '), /kind must be one of/);
});

test('verification reads the diff: project checks from the base, edited tests, flaky checks', async () => {
  const { runAcceptance, globToRegExp, lockAcceptance, acceptanceChanged, renderReport } = await import('../src/verify.mjs');
  const cwd = mkdtempSync(join(tmpdir(), 'orch-v2-'));
  const acceptance = [{ id: 'a', criterion: 'works', check: 'ok', kind: 'e2e', confidence: 90 }];
  const ok = async () => ({ passed: true, output: '' });

  assert.ok(globToRegExp('src/db/**').test('src/db/migrations/001.sql'));
  assert.ok(globToRegExp('**/*.sql').test('a/b/c.sql'));
  assert.ok(!globToRegExp('src/*.js').test('src/a/b.js'));

  // a matching project check runs, and an `ask` item needs a person
  const standing = (_c, _b, files) => files.some((f) => f.path.startsWith('src/db/')) ? [{ id: 'old-rows', criterion: 'Old rows still load', manual: 'Does the new column have a default?', standing: true }] : [];
  const withDb = await runAcceptance({ acceptance }, { cwd, sh: ok, base: 'b', diff: () => [{ status: 'M', path: 'src/db/schema.js' }], standing });
  assert.equal(withDb.verdict, 'needs_human');
  assert.match(renderReport(withDb), /Old rows still load \*\(project check\)\*/);
  assert.equal((await runAcceptance({ acceptance }, { cwd, sh: ok, base: 'b', diff: () => [{ status: 'M', path: 'src/ui/a.js' }], standing })).verdict, 'pass');

  // rewriting an existing test needs a person; adding a new one does not
  const edited = await runAcceptance({ acceptance }, { cwd, sh: ok, base: 'b', diff: () => [{ status: 'M', path: 'test/login.test.js' }, { status: 'A', path: 'test/new.test.js' }], standing: () => [] });
  assert.equal(edited.verdict, 'needs_human');
  assert.match(edited.flags[0], /already existed: test\/login\.test\.js\./);
  assert.equal((await runAcceptance({ acceptance }, { cwd, sh: ok, base: 'b', diff: () => [{ status: 'A', path: 'test/new.test.js' }], standing: () => [] })).verdict, 'pass');

  // passes once, fails on the rerun
  let n = 0;
  const flaky = await runAcceptance({ acceptance }, { cwd, repeat: 2, sh: async () => ({ passed: ++n === 1, output: 'x' }), diff: () => [], standing: () => [] });
  assert.equal(flaky.verdict, 'fail');
  assert.match(flaky.criteria[0].reason, /flaky/);

  // the criteria are frozen once the run starts
  lockAcceptance({ acceptance }, cwd);
  assert.equal(acceptanceChanged({ acceptance }, cwd), false);
  assert.equal(acceptanceChanged({ acceptance: [{ ...acceptance[0], check: 'true' }] }, cwd), true);
});

test('gate: flags hold the PR for a person, and observe mode never merges', async () => {
  const { decide, gate } = await import('../src/pr.mjs');
  const v = { verdict: 'needs_human', head: 'abc', dirty: false, flags: ['This change edits or removes tests that already existed: a.test.js.'], criteria: [{ id: 'a', status: 'pass' }] };
  assert.equal(decide(v, { head: 'abc', pendingChecks: 0, items: [] }).state, 'pending');
  const calls = [];
  const gh = async (args) => { calls.push(args); return args[1] === 'graphql' ? JSON.stringify({ data: { repository: { pullRequest: prFixture() } } }) : '{}'; };
  const r = await gate({ owner: 'o', repo: 'r', number: 7 }, { verdict: 'pass', head: 'abc', dirty: false, flags: [], criteria: [{ id: 'a', status: 'pass' }] }, 'R', { approve: 'observe', gh });
  assert.match(r.approval, /would have auto-merged/);
  assert.ok(!calls.some((a) => a[1] === 'merge'));
});

test('verify skill: missing, unsynced, current, then stale when covered code changes', async () => {
  const { verifySkillStatus, renderVerifySkill } = await import('../src/verify.mjs');
  const { execFileSync } = await import('node:child_process');
  const { mkdirSync, writeFileSync, symlinkSync } = await import('node:fs');
  const cwd = mkdtempSync(join(tmpdir(), 'orch-vs-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd }).toString().trim();
  g('init', '-q');
  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'src/app.js'), '1');
  writeFileSync(join(cwd, 'README.md'), '1');
  g('add', '-A'); g('commit', '-qm', 'one');
  const sha = g('rev-parse', 'HEAD');
  assert.equal(verifySkillStatus(cwd).state, 'missing');

  const dir = join(cwd, '.claude/skills/verify-shop');
  mkdirSync(dir, { recursive: true });
  const write = (extra) => writeFileSync(join(dir, 'SKILL.md'), `---\nname: verify-shop\ndescription: d\n${extra}---\nbody`);
  write('');
  assert.equal(verifySkillStatus(cwd).state, 'unsynced');
  write(`covers: src/**, app/**\nsync: ${sha}\n`);
  mkdirSync(join(cwd, '.agents/skills'), { recursive: true });
  symlinkSync(dir, join(cwd, '.agents/skills/verify-shop'));
  assert.equal(verifySkillStatus(cwd).state, 'current');

  writeFileSync(join(cwd, 'README.md'), '2');
  g('add', '-A'); g('commit', '-qm', 'docs only');
  assert.equal(verifySkillStatus(cwd).state, 'current');
  writeFileSync(join(cwd, 'src/app.js'), '2');
  g('add', '-A'); g('commit', '-qm', 'code');
  const stale = verifySkillStatus(cwd);
  assert.equal(stale.state, 'stale');
  assert.deepEqual(stale.changed, ['src/app.js']);
  assert.match(renderVerifySkill(stale), /verify-shop is stale. 1 covered file/);
});

test('bundled skills are indexed last, never shadow yours, and pstack: forces them', async () => {
  const { indexSkills, findSkill } = await import('../src/skills.mjs');
  const { buildPrompt } = await import('../src/runner.mjs');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'orch-b-'));
  const mk = (dir, name, desc) => { mkdirSync(join(root, dir, name), { recursive: true }); writeFileSync(join(root, dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n`); };
  mk('proj/.claude/skills', 'tdd', 'my own tdd');
  mk('bundled', 'tdd', 'pstack tdd');
  mk('bundled', 'blast-radius', 'what else breaks');
  const skills = indexSkills(join(root, 'proj'), join(root, 'bundled')).filter((s) => s.path.startsWith(root) || s.path.includes('orch-b-'));
  const mine = findSkill(skills, 'tdd');
  assert.equal(mine.description, 'my own tdd');
  assert.equal(findSkill(skills, 'pstack:tdd').description, 'pstack tdd');
  assert.equal(findSkill(skills, 'pstack:tdd').shadowed, true);
  assert.equal(findSkill(skills, 'blast-radius').bundled, true);
  assert.equal(findSkill(skills, 'pstack:nope'), null);
  const prompt = buildPrompt({ plan: {}, task: { id: 'a', prompt: 'p', mode: 'write' }, skill: findSkill(skills, 'blast-radius'), depResults: [] });
  assert.match(prompt, /written for Cursor/);
  assert.doesNotMatch(buildPrompt({ plan: {}, task: { id: 'a', prompt: 'p', mode: 'write' }, skill: mine, depResults: [] }), /written for Cursor/);
});

test('independent verdicts: the author does not count, edits void it, and the gate holds without one', async () => {
  const { judgeVerdict } = await import('../src/verify.mjs');
  const { decide } = await import('../src/pr.mjs');
  const v = (o = {}) => ({ result: 'PASS', by: 'codex/default@high', patchId: 'p1', notes: '', ...o });
  const ctx = { authors: ['claude/opus'], currentPatchId: 'p1' };
  assert.equal(judgeVerdict(v(), ctx).ok, true);
  assert.equal(judgeVerdict(v({ result: 'PASS+NOTES' }), ctx).ok, true);
  assert.match(judgeVerdict(null, ctx).reason, /nobody but the author/);
  assert.match(judgeVerdict(v({ by: 'claude/opus@low' }), ctx).reason, /also wrote the code/);
  assert.match(judgeVerdict(v(), { ...ctx, currentPatchId: 'p2' }).reason, /edited since/);
  assert.equal(judgeVerdict(v({ result: 'INCONCLUSIVE', notes: 'could not start the app' }), ctx).ok, false);
  assert.equal(judgeVerdict(v({ result: 'FAIL', notes: 'export writes nothing' }), ctx).failed, true);

  const ver = { verdict: 'pass', head: 'abc', dirty: false, flags: [], criteria: [{ id: 'a', status: 'pass' }] };
  const fb = { head: 'abc', pendingChecks: 0, items: [] };
  assert.equal(decide(ver, fb).state, 'success');
  assert.equal(decide(ver, fb, judgeVerdict(v(), ctx)).state, 'success');
  assert.equal(decide(ver, fb, judgeVerdict(null, ctx)).state, 'pending');
  assert.equal(decide(ver, fb, judgeVerdict(v({ result: 'INCONCLUSIVE' }), ctx)).state, 'pending');
  assert.equal(decide(ver, fb, judgeVerdict(v({ result: 'FAIL', notes: 'x' }), ctx)).state, 'failure');
});

test('a verdict survives a rebase that leaves the change itself untouched', async () => {
  const { recordVerdict, patchId, authorsOf } = await import('../src/verify.mjs');
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const cwd = mkdtempSync(join(tmpdir(), 'orch-pid-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd }).toString().trim();
  g('init', '-q', '-b', 'main');
  writeFileSync(join(cwd, 'a.txt'), 'one\n'); writeFileSync(join(cwd, 'other.txt'), 'x\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  g('switch', '-qc', 'feature');
  writeFileSync(join(cwd, 'a.txt'), 'two\n'); g('commit', '-qam', 'change');
  const verdict = recordVerdict(cwd, { result: 'PASS', by: 'codex/default', base: 'main' });
  assert.ok(verdict.patchId);
  assert.deepEqual(authorsOf(cwd), []);
  g('switch', '-q', 'main'); writeFileSync(join(cwd, 'other.txt'), 'y\n'); g('commit', '-qam', 'unrelated');
  g('switch', '-q', 'feature'); g('rebase', '-q', 'main');
  assert.notEqual(g('rev-parse', 'HEAD'), verdict.head);
  assert.equal(patchId(cwd, 'main'), verdict.patchId);
  writeFileSync(join(cwd, 'a.txt'), 'three\n'); g('commit', '-qam', 'edit');
  assert.notEqual(patchId(cwd, 'main'), verdict.patchId);
  assert.throws(() => recordVerdict(cwd, { result: 'MAYBE', by: 'x' }), /Verdict must be/);
});
