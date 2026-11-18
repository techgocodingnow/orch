// Skill discovery: index every SKILL.md the installed agents can see, then rank
// them against a task description. Ranking is lexical and only shortlists; the
// calling agent makes the final pick from the descriptions.
import { readdirSync, readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';

const STOP = new Set(
  'a an and are as at be by for from has have how i in into is it its of on or that the this to use used using user users want wants when with you your skill skills task tasks'.split(' '),
);

export function skillRoots(cwd = process.cwd()) {
  const home = homedir();
  const roots = [];
  for (const [agent, dir] of [['claude', '.claude'], ['codex', '.codex'], ['cursor', '.cursor'], ['shared', '.agents']]) {
    roots.push({ agent, scope: 'user', dir: join(home, dir, 'skills') });
    roots.push({ agent, scope: 'project', dir: join(cwd, dir, 'skills') });
  }
  return roots;
}

function findSkillFiles(dir, depth) {
  if (depth < 0 || !existsSync(dir)) return [];
  const found = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git') continue;
    const path = join(dir, name);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) found.push(...findSkillFiles(path, depth - 1));
    else if (name === 'SKILL.md') found.push(path);
  }
  return found;
}

export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const meta = {};
  if (!match) return meta;
  let key = null;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      meta[key] = kv[2].replace(/^[>|][+-]?\s*$/, '').replace(/^["']|["']$/g, '');
    } else if (key && /^\s+\S/.test(line)) {
      meta[key] = `${meta[key]} ${line.trim()}`.trim();
    }
  }
  return meta;
}

export function indexSkills(cwd = process.cwd()) {
  const byPath = new Map();
  const add = (file, agent, scope) => {
    let real;
    try {
      real = realpathSync(file);
    } catch {
      return;
    }
    const existing = byPath.get(real);
    if (existing) {
      if (!existing.agents.includes(agent)) existing.agents.push(agent);
      return;
    }
    const meta = parseFrontmatter(readFileSync(real, 'utf8'));
    byPath.set(real, {
      name: meta.name || basename(dirname(real)),
      description: meta.description || '',
      path: real,
      agents: [agent],
      scope,
    });
  };
  for (const root of skillRoots(cwd)) {
    for (const file of findSkillFiles(root.dir, 2)) add(file, root.agent, root.scope);
  }
  // Claude Code plugins keep their skills under the plugin cache.
  const plugins = join(homedir(), '.claude', 'plugins', 'cache');
  for (const file of findSkillFiles(plugins, 6)) add(file, 'claude', 'plugin');
  return [...byPath.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function tokenize(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? [])
    .map((w) => w.replace(/(ing|ed|es|s)$/, ''))
    .filter((w) => w.length > 2 && !STOP.has(w));
}

export function rankSkills(skills, query, top = 8) {
  const q = [...new Set(tokenize(query))];
  if (!q.length) return [];
  const docs = skills.map((s) => ({ s, name: new Set(tokenize(s.name)), body: new Set(tokenize(s.description)) }));
  const idf = new Map(
    q.map((term) => {
      const df = docs.filter((d) => d.name.has(term) || d.body.has(term)).length;
      return [term, Math.log(1 + docs.length / (1 + df))];
    }),
  );
  return docs
    .map(({ s, name, body }) => {
      let score = 0;
      const matched = [];
      for (const term of q) {
        const hit = (name.has(term) ? 2 : 0) + (body.has(term) ? 1 : 0);
        if (hit) {
          score += hit * idf.get(term);
          matched.push(term);
        }
      }
      return { ...s, score: Math.round(score * 100) / 100, matched };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top);
}
