import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MODELS } from '../src/catalog.mjs';
import { route } from '../src/router.mjs';
import { run } from '../src/runner.mjs';

const config = { models: DEFAULT_MODELS, concurrency: 4, timeoutMinutes: 1, escalate: true };
const agents = ['claude', 'codex'];
const t = (id, o = {}) => ({ id, kind: 'explore', complexity: 'S', mode: 'read', prompt: `do ${id}`, ...o });
const setup = (tasks, extra = {}) => {
  const plan = { goal: 'g', tasks };
  return { plan, routed: route(plan, { models: DEFAULT_MODELS, agents, ...extra }), cwd: mkdtempSync(join(tmpdir(), 'orch-')) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('runs deps in order and passes their reports downstream', async () => {
  const { plan, routed, cwd } = setup([t('a'), t('b', { deps: ['a'] })]);
  const prompts = {};
  const invoke = async ({ prompt, logPath }) => {
    const id = logPath.match(/([^/]+)\.log$/)[1];
    prompts[id] = prompt;
    return { ok: true, text: `report from ${id}`, usd: 0.01, usdSource: 'reported', durationMs: 5 };
  };
  const s = await run(plan, routed, { cwd, config, agents, invoke });
  assert.equal(s.ok, true);
  assert.equal(s.spentUsd, 0.02);
  assert.match(prompts.b, /report from a/);
  assert.match(prompts.a, /read-only/);
  assert.equal(readFileSync(join(s.runDir, 'b.result.md'), 'utf8'), 'report from b');
});

test('read tasks overlap, write tasks take turns', async () => {
  const { plan, routed, cwd } = setup([t('r1'), t('r2'), t('w1', { mode: 'write' }), t('w2', { mode: 'write' })]);
  let live = 0, liveWrites = 0, maxLive = 0, maxWrites = 0;
  const invoke = async ({ mode }) => {
    live++; if (mode === 'write') liveWrites++;
    maxLive = Math.max(maxLive, live); maxWrites = Math.max(maxWrites, liveWrites);
    await sleep(30);
    live--; if (mode === 'write') liveWrites--;
    return { ok: true, text: 'ok', usd: 0, durationMs: 30 };
  };
  await run(plan, routed, { cwd, config, agents, invoke });
  assert.ok(maxLive >= 3);
  assert.equal(maxWrites, 1);
});

test('a failure escalates once, then skips dependents', async () => {
  const { plan, routed, cwd } = setup([t('a'), t('b', { deps: ['a'] }), t('c')]);
  const tried = [];
  const invoke = async ({ assignment, logPath }) => {
    if (logPath.endsWith('a.log')) { tried.push(assignment.id); return { ok: false, text: '', usd: 0.01, error: 'boom', durationMs: 1 }; }
    return { ok: true, text: 'ok', usd: 0, durationMs: 1 };
  };
  const s = await run(plan, routed, { cwd, config, agents, invoke });
  const status = Object.fromEntries(s.tasks.map((x) => [x.id, x.status]));
  assert.deepEqual(status, { a: 'failed', b: 'skipped', c: 'done' });
  assert.equal(tried.length, 2);
  assert.notEqual(tried[0], tried[1]);
  assert.equal(s.ok, false);
  assert.equal(s.spentUsd, 0.02);
});

test('stops starting tasks once the budget is spent, and caps each task', async () => {
  const { plan, routed, cwd } = setup([t('a'), t('b', { deps: ['a'] })], { budget: 1 });
  const caps = [];
  const invoke = async ({ maxUsd }) => { caps.push(maxUsd); return { ok: true, text: 'ok', usd: 1.2, durationMs: 1 }; };
  const s = await run(plan, routed, { cwd, config, agents, invoke });
  assert.equal(s.tasks[1].status, 'skipped');
  assert.match(s.tasks[1].error, /budget/);
  assert.ok(caps[0] > 0 && caps[0] <= 1);
  assert.equal(s.tasks[0].usd, 1.2);
});
