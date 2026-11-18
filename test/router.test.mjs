import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_MODELS } from '../src/catalog.mjs';
import { validatePlan, route, escalate, floorFor } from '../src/router.mjs';

const plan = JSON.parse(readFileSync(new URL('../examples/plan.json', import.meta.url)));
const base = { models: DEFAULT_MODELS, agents: ['claude', 'codex'] };
const pick = (r, id) => r.tasks.find((t) => t.id === id).assignment;

test('the example plan is valid', () => assert.deepEqual(validatePlan(plan), []));

test('validation reports bad fields, unknown deps and cycles', () => {
  const t = (o) => ({ id: 'a', kind: 'explore', complexity: 'S', mode: 'read', prompt: 'p', ...o });
  assert.match(validatePlan({ tasks: [t({ kind: 'nope' })] })[0], /kind/);
  assert.match(validatePlan({ tasks: [t({ deps: ['zzz'] })] })[0], /unknown dep/);
  assert.match(validatePlan({ tasks: [t({ deps: ['b'] }), t({ id: 'b', deps: ['a'] })] })[0], /cycle/);
});

test('every task gets a model at or above its quality floor', () => {
  for (const profile of ['cheap', 'balanced', 'fast', 'quality']) {
    const r = route(plan, { ...base, profile });
    for (const t of r.tasks) assert.ok(t.assignment.quality >= t.assignment.floor, `${profile}/${t.id}`);
  }
});

test('easy work goes to cheaper models than hard work', () => {
  for (const profile of ['cheap', 'balanced', 'fast']) {
    const r = route(plan, { ...base, profile });
    assert.ok(pick(r, 'map').estUsd < pick(r, 'design').estUsd, profile);
  }
  assert.equal(pick(route(plan, { ...base, profile: 'cheap' }), 'map').modelId, 'claude/haiku');
});

test('profiles order total cost: cheap <= balanced <= quality', () => {
  const cost = (profile) => route(plan, { ...base, profile }).totalUsd;
  assert.ok(cost('cheap') <= cost('balanced'));
  assert.ok(cost('balanced') < cost('quality'));
});

test('a budget pulls the plan down without breaking floors', () => {
  const free = route(plan, { ...base, profile: 'quality' });
  const cheap = route(plan, { ...base, profile: 'cheap' });
  const budget = (free.totalUsd + cheap.totalUsd) / 2;
  const r = route(plan, { ...base, profile: 'quality', budget });
  assert.equal(r.status, 'ok');
  assert.ok(r.totalUsd <= budget);
  for (const t of r.tasks) assert.ok(t.assignment.quality >= t.assignment.floor);
});

test('an impossible budget is reported, and --relax trades quality for it', () => {
  const strict = route(plan, { ...base, budget: 0.01 });
  assert.equal(strict.status, 'over_budget');
  for (const t of strict.tasks) assert.ok(t.assignment.quality >= t.assignment.floor);
  const relaxed = route(plan, { ...base, budget: 0.01, relax: true });
  assert.ok(relaxed.totalUsd < strict.totalUsd);
  assert.ok(relaxed.notes.some((n) => /below its quality floor/.test(n)));
});

test('pins are honoured and survive budget pressure', () => {
  const pinned = structuredClone(plan);
  pinned.tasks[0].model = 'claude/fable@high';
  pinned.tasks[2].agent = 'codex';
  const r = route(pinned, { ...base, budget: 0.01 });
  assert.equal(pick(r, 'map').id, 'claude/fable@high');
  assert.equal(pick(r, 'build').agent, 'codex');
});

test('maxCost caps a single task', () => {
  const capped = structuredClone(plan);
  const build = capped.tasks.find((t) => t.id === 'build');
  const uncapped = pick(route(capped, { ...base, profile: 'quality' }), 'build').estUsd;
  build.maxCost = 0.6;
  const r = route(capped, { ...base, profile: 'quality' });
  assert.ok(uncapped > 0.6 && pick(r, 'build').estUsd <= 0.6);
  // Nothing good enough is that cheap: keep the floor, say so.
  build.maxCost = 0.01;
  const tight = route(capped, { ...base, profile: 'quality' });
  assert.ok(pick(tight, 'build').quality >= pick(tight, 'build').floor);
  assert.ok(tight.notes.some((n) => /maxCost/.test(n)));
});

test('only available agents are used', () => {
  const r = route(plan, { ...base, agents: ['codex'] });
  assert.ok(r.tasks.every((t) => t.assignment.agent === 'codex'));
  assert.throws(() => route(plan, { ...base, agents: [] }), /No usable agent/);
});

test('review prefers a different vendor than the author', () => {
  const p = structuredClone(plan);
  p.tasks.find((t) => t.id === 'build').agent = 'claude';
  p.tasks.find((t) => t.id === 'tests').agent = 'claude';
  assert.equal(pick(route(p, base), 'review').agent, 'codex');
});

test('escalate moves to a strictly better model, or null at the top', () => {
  const r = route(plan, base);
  const task = plan.tasks[0];
  const next = escalate(task, pick(r, 'map'), base.models, base.agents);
  assert.ok(next.quality > pick(r, 'map').quality);
  assert.equal(escalate(task, { quality: 10, floor: 4 }, base.models, base.agents), null);
  assert.equal(escalate({ ...task, model: 'claude/haiku' }, pick(r, 'map'), base.models, base.agents), null);
  assert.equal(escalate({ ...task, agent: 'codex' }, { quality: 5, floor: 4 }, base.models, base.agents).agent, 'codex');
});

test('floors rise with complexity and cap out', () => {
  const f = (kind, complexity) => floorFor({ kind, complexity }, 'balanced');
  assert.ok(f('implement', 'S') < f('implement', 'M'));
  assert.equal(f('design', 'L'), 9.5);
});
