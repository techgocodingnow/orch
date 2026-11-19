// Model catalog and config loading.
//
// Prices are USD per million tokens. quality and speed are 1-10 heuristics that
// drive routing; they are opinions, not benchmarks. Override any of it in
// ~/.config/orch/config.json or <project>/.orch/config.json.
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_MODELS = [
  { id: 'claude/haiku', agent: 'claude', model: 'haiku', in: 0.1, out: 0.5, quality: 5, speed: 10, efforts: ['low', 'medium', 'high'] },
  { id: 'claude/sonnet', agent: 'claude', model: 'sonnet', in: 2, out: 10, quality: 7, speed: 8, efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'claude/opus', agent: 'claude', model: 'opus', in: 4, out: 20, quality: 9, speed: 6, efforts: ['low', 'medium', 'high', 'xhigh'] },
  { id: 'claude/fable', agent: 'claude', model: 'fable', in: 8, out: 40, quality: 10, speed: 4, efforts: ['low', 'medium', 'high', 'xhigh'] },
  // model: null runs whatever ~/.codex/config.toml selects, or the first model
  // your account lists when that one is not available. The price is a
  // placeholder: set it to your model's real rate (or 0 on a flat subscription).
  { id: 'codex/default', agent: 'codex', model: null, in: 2.5, out: 15, quality: 8.5, speed: 6, efforts: ['low', 'medium', 'high'], priceEstimated: true },
  { id: 'cursor/auto', agent: 'cursor', model: 'auto', in: 1.5, out: 8, quality: 7, speed: 7, efforts: [], priceEstimated: true },
];

// How an effort level shifts a model: quality points added, cost multiplier,
// speed multiplier.
export const EFFORTS = {
  low: { q: -0.6, cost: 0.6, speed: 1.3 },
  medium: { q: 0, cost: 1, speed: 1 },
  high: { q: 0.4, cost: 1.6, speed: 0.75 },
  xhigh: { q: 0.7, cost: 2.4, speed: 0.55 },
};

// Every headless call pays for the agent's own system prompt and tool
// definitions before it reads a line of your task. Measured at about 40k tokens
// per call for both Claude Code and Codex; the first turn writes them to cache.
export const OVERHEAD_TOKENS = 60_000;

// Billable-equivalent tokens per task size. Agent loops reread cached context,
// so input here is already discounted for cache hits. Rough on purpose.
export const SIZES = {
  S: { in: 20_000, out: 3_000 },
  M: { in: 80_000, out: 12_000 },
  L: { in: 300_000, out: 40_000 },
};

// Minimum effective quality a task kind needs at complexity M.
export const KIND_FLOORS = {
  mechanical: 4.5,
  explore: 5,
  docs: 6,
  test: 6.5,
  implement: 7.5,
  debug: 8,
  review: 8,
  design: 9,
};
export const COMPLEXITY_SHIFT = { S: -1, M: 0, L: 1 };
export const MAX_FLOOR = 9.5;

// Routing weights: quality headroom above the floor, cost, speed.
export const PROFILES = {
  cheap: { q: 0.1, cost: 1, speed: 0.1, floorShift: 0 },
  balanced: { q: 0.25, cost: 0.5, speed: 0.25, floorShift: 0 },
  fast: { q: 0.2, cost: 0.2, speed: 0.6, floorShift: 0 },
  quality: { q: 1, cost: 0.1, speed: 0.1, floorShift: 1 },
};

export const DEFAULT_CONFIG = {
  // No spending level set means best quality. Cheaper profiles are opt-in.
  profile: 'quality',
  budget: null,
  concurrency: 4,
  timeoutMinutes: 30,
  escalate: true,
  // Cursor's adapter has never been run against a real account, so it is opt-in.
  agents: { cursor: { enabled: false } },
  // Task kind -> model, for kinds you always want on a specific model.
  roles: {},
  // Who approves a PR that passed: 'human', or 'auto' to enable GitHub auto-merge.
  approve: 'human',
  // Plan confidence, 0-100, needed to start a run with nobody watching.
  minConfidence: 70,
  // Require a verdict from a session that did not write the code before the
  // gate can pass. Always required for auto-merge, whatever this says.
  requireVerdict: false,
  models: [],
};

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Invalid JSON in ${path}: ${err.message}`);
  }
}

export function configPaths(cwd = process.cwd()) {
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return [join(xdg, 'orch', 'config.json'), join(cwd, '.orch', 'config.json')];
}

export function loadConfig(cwd = process.cwd()) {
  const config = structuredClone(DEFAULT_CONFIG);
  const byId = new Map(DEFAULT_MODELS.map((m) => [m.id, { ...m }]));
  for (const path of configPaths(cwd)) {
    const layer = readJson(path);
    if (!layer) continue;
    for (const m of layer.models ?? []) {
      if (!m.id) throw new Error(`${path}: every models[] entry needs an id`);
      byId.set(m.id, { ...(byId.get(m.id) ?? {}), ...m });
    }
    Object.assign(config.agents, layer.agents ?? {});
    for (const key of ['jira', 'notify', 'roles']) if (layer[key]) config[key] = { ...(config[key] ?? {}), ...layer[key] };
    for (const key of ['profile', 'budget', 'concurrency', 'timeoutMinutes', 'escalate', 'approve', 'minConfidence', 'requireVerdict']) {
      if (layer[key] !== undefined) config[key] = layer[key];
    }
  }
  config.models = [...byId.values()].filter((m) => m.enabled !== false);
  return config;
}
