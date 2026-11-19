// Routing: pick an agent, model and effort for every task in a plan, then fit
// the plan to a budget. Pure functions, no I/O.
import { validateAcceptance } from './verify.mjs';
import { EFFORTS, SIZES, OVERHEAD_TOKENS, KIND_FLOORS, COMPLEXITY_SHIFT, MAX_FLOOR, PROFILES } from './catalog.mjs';

const MODES = ['read', 'write'];

export function validatePlan(plan) {
  const errors = [];
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    return ['plan.tasks must be a non-empty array'];
  }
  const ids = new Set();
  for (const [i, t] of plan.tasks.entries()) {
    const at = `tasks[${i}]${t.id ? ` (${t.id})` : ''}`;
    if (!t.id || !/^[a-zA-Z0-9_-]+$/.test(t.id)) errors.push(`${at}: id must match [a-zA-Z0-9_-]+`);
    if (ids.has(t.id)) errors.push(`${at}: duplicate id`);
    ids.add(t.id);
    if (t.needsHuman != null && typeof t.needsHuman !== 'string') errors.push(`${at}: needsHuman must be a sentence saying what a person has to decide`);
    if (t.verify != null && typeof t.verify !== 'string') errors.push(`${at}: verify must be a shell command`);
    if (t.needsHuman) continue; // a human task needs no kind, size or mode
    if (!t.prompt) errors.push(`${at}: prompt is required`);
    if (!(t.kind in KIND_FLOORS)) errors.push(`${at}: kind must be one of ${Object.keys(KIND_FLOORS).join(', ')}`);
    if (!(t.complexity in SIZES)) errors.push(`${at}: complexity must be S, M or L`);
    if (!MODES.includes(t.mode)) errors.push(`${at}: mode must be read or write`);
  }
  for (const t of plan.tasks) {
    for (const d of t.deps ?? []) if (!ids.has(d)) errors.push(`${t.id}: unknown dep "${d}"`);
  }
  if (errors.length === 0 && !topoOrder(plan.tasks)) errors.push('tasks have a dependency cycle');
  errors.push(...validateAcceptance(plan.acceptance));
  const u = plan.confidence?.understanding;
  if (u != null && !(typeof u === 'number' && u >= 0 && u <= 100)) errors.push('confidence.understanding must be a number from 0 to 100');
  return errors;
}

export function topoOrder(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map();
  const order = [];
  const visit = (t) => {
    if (state.get(t.id) === 2) return true;
    if (state.get(t.id) === 1) return false;
    state.set(t.id, 1);
    for (const d of t.deps ?? []) if (!visit(byId.get(d))) return false;
    state.set(t.id, 2);
    order.push(t);
    return true;
  };
  for (const t of tasks) if (!visit(t)) return null;
  return order;
}

// Every (model, effort) pair the available agents can run.
export function candidates(models, availableAgents) {
  const out = [];
  for (const m of models) {
    if (!availableAgents.includes(m.agent)) continue;
    const efforts = m.efforts?.length ? m.efforts : [null];
    for (const effort of efforts) {
      const e = EFFORTS[effort] ?? EFFORTS.medium;
      out.push({
        id: effort ? `${m.id}@${effort}` : m.id,
        modelId: m.id,
        agent: m.agent,
        model: m.model,
        effort,
        in: m.in,
        out: m.out,
        costMult: e.cost,
        quality: Math.min(10, m.quality + e.q),
        speed: Math.min(10, m.speed * e.speed),
        priceEstimated: Boolean(m.priceEstimated),
      });
    }
  }
  return out;
}

export function estimateUsd(task, cand) {
  const size = SIZES[task.complexity];
  return ((size.in * cand.in + size.out * cand.out) * cand.costMult + OVERHEAD_TOKENS * cand.in) / 1e6;
}

export function floorFor(task, profileName) {
  const shift = PROFILES[profileName].floorShift;
  return Math.min(MAX_FLOOR, KIND_FLOORS[task.kind] + COMPLEXITY_SHIFT[task.complexity] + shift);
}

function utility(cand, task, floor, pool, profile, avoidAgents) {
  const costs = pool.map((c) => Math.log(estimateUsd(task, c) + 1e-9));
  const lo = Math.min(...costs);
  const hi = Math.max(...costs);
  const cost = hi === lo ? 0 : (Math.log(estimateUsd(task, cand) + 1e-9) - lo) / (hi - lo);
  // Quality beyond the floor is worth something, with a ceiling.
  const headroom = Math.max(0, Math.min(1, (cand.quality - floor) / 4));
  // A reviewer from a different vendor than the author catches different bugs.
  const diversity = task.kind === 'review' && avoidAgents.size && !avoidAgents.has(cand.agent) ? 0.15 : 0;
  return profile.q * headroom - profile.cost * cost + profile.speed * (cand.speed / 10) + diversity;
}

function pinnedPool(task, all, notes, roles) {
  let pool = all;
  const pin = task.model ?? roles?.[task.kind];
  if (pin) {
    const exact = all.filter((c) => c.id === pin);
    const byModel = all.filter((c) => c.modelId === pin);
    pool = exact.length ? exact : byModel;
    if (!pool.length) {
      notes.push(`${task.id}: pinned model "${pin}" is not available, routing normally`);
      pool = all;
    }
  }
  if (task.agent) {
    const byAgent = pool.filter((c) => c.agent === task.agent);
    if (byAgent.length) pool = byAgent;
    else notes.push(`${task.id}: pinned agent "${task.agent}" is not available, routing normally`);
  }
  return pool;
}

// Candidates that may serve a task: at or above the floor, within its maxCost.
function eligible(task, pool, floor, notes) {
  let ok = pool.filter((c) => c.quality >= floor);
  if (!ok.length) {
    const best = Math.max(...pool.map((c) => c.quality));
    ok = pool.filter((c) => c.quality === best);
    notes?.push(`${task.id}: nothing reaches quality ${floor}, using the best available (${ok[0].id})`);
  }
  if (task.maxCost != null) {
    const capped = ok.filter((c) => estimateUsd(task, c) <= task.maxCost);
    if (capped.length) return capped;
    const cheapest = ok.reduce((a, b) => (estimateUsd(task, a) <= estimateUsd(task, b) ? a : b));
    notes?.push(`${task.id}: no model fits maxCost $${task.maxCost}, using the cheapest eligible (${cheapest.id})`);
    return [cheapest];
  }
  return ok;
}

export function route(plan, { models, agents, profile = 'quality', budget = null, relax = false, roles = {} }) {
  if (!(profile in PROFILES)) throw new Error(`Unknown profile "${profile}". Use ${Object.keys(PROFILES).join(', ')}`);
  const all = candidates(models, agents);
  if (!all.length) throw new Error('No usable agent. Run `orch detect` to see why.');
  const weights = PROFILES[profile];
  const notes = [];
  const picks = new Map();

  for (const task of topoOrder(plan.tasks)) {
    if (task.needsHuman) continue; // no model does this one
    const floor = floorFor(task, profile);
    const pool = pinnedPool(task, all, notes, roles);
    const hasPin = Boolean(task.model ?? roles[task.kind]);
    const pinned = pool !== all;
    const ok = pinned && hasPin ? pool : eligible(task, pool, floor, notes);
    const avoid = new Set((task.deps ?? []).map((d) => picks.get(d)?.cand.agent).filter(Boolean));
    const score = (c) => utility(c, task, floor, ok, weights, avoid);
    const cand = ok.reduce((a, b) => (score(b) > score(a) ? b : a));
    picks.set(task.id, { task, cand, floor, pool, pinned: pinned && hasPin, score });
  }

  const total = () => [...picks.values()].reduce((sum, p) => sum + estimateUsd(p.task, p.cand), 0);

  // Over budget: repeatedly take the downgrade that saves the most per unit of
  // utility lost. Floors hold unless relax is set.
  if (budget != null) {
    while (total() > budget) {
      let best = null;
      for (const p of picks.values()) {
        if (p.pinned) continue;
        const floor = relax ? p.floor - 1.5 : p.floor;
        const now = estimateUsd(p.task, p.cand);
        for (const c of p.pool) {
          const cost = estimateUsd(p.task, c);
          if (c.quality < floor || cost >= now) continue;
          if (p.task.maxCost != null && cost > p.task.maxCost) continue;
          const ratio = (now - cost) / (Math.max(0, p.score(p.cand) - p.score(c)) + 0.05);
          if (!best || ratio > best.ratio) best = { p, c, ratio };
        }
      }
      if (!best) break;
      if (best.c.quality < best.p.floor) {
        notes.push(`${best.p.task.id}: dropped below its quality floor (${best.p.floor}) to fit the budget`);
      }
      best.p.cand = best.c;
    }
  }

  const tasks = plan.tasks.map((task) => {
    if (task.needsHuman) return { id: task.id, title: task.title ?? task.id, needsHuman: task.needsHuman, assignment: null };
    const { cand, floor } = picks.get(task.id);
    return {
      id: task.id,
      title: task.title ?? task.id,
      kind: task.kind,
      complexity: task.complexity,
      mode: task.mode,
      assignment: { ...cand, floor, estUsd: round(estimateUsd(task, cand)) },
    };
  });
  const totalUsd = round(total());
  if (tasks.some((t) => t.assignment?.priceEstimated)) {
    notes.push('Some prices are placeholders (marked ~). Set real rates in ~/.config/orch/config.json.');
  }
  return {
    profile,
    budget,
    totalUsd,
    status: budget != null && totalUsd > budget ? 'over_budget' : 'ok',
    tasks,
    notes,
  };
}

// Next step up after a failure: the cheapest candidate that is strictly better.
export function escalate(task, current, models, agents) {
  if (task.model) return null; // the user chose this model, do not swap it
  const better = candidates(models, agents).filter(
    (c) => c.quality > current.quality && (!task.agent || c.agent === task.agent),
  );
  if (!better.length) return null;
  const cand = better.reduce((a, b) => (estimateUsd(task, a) <= estimateUsd(task, b) ? a : b));
  return { ...cand, floor: current.floor, estUsd: round(estimateUsd(task, cand)) };
}

const round = (n) => Math.round(n * 10000) / 10000;
