#!/usr/bin/env node
// Copy a chosen set of pstack skills and playbooks into vendor/pstack, unmodified.
// pstack is MIT licensed: https://github.com/cursor/plugins/tree/main/pstack
//
//   node scripts/vendor-pstack.mjs            latest main
//   node scripts/vendor-pstack.mjs <commit>   a specific commit
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Set PSTACK_REPO to an SSH URL if anonymous HTTPS is rate-limited.
const REPO = process.env.PSTACK_REPO || 'https://github.com/cursor/plugins.git';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEST = join(ROOT, 'vendor', 'pstack');

// Skills one agent can follow by reading the file. Left out on purpose: the
// ones built on Cursor's subagent fan-out (arena, swarm, interrogate, teach,
// recall), which orch's own runner replaces; poteto-mode and its setup, which
// orchestrate replaces; and create/maintain-verification-skill, which
// orch-verify adapts.
const SKILLS = [
  'tdd', 'blast-radius', 'benchmark-checklist', 'architect', 'how', 'why', 'in-your-own-words', 'figure-it-out',
  'show-me-your-work', 'reflect', 'correct', 'unslop', 'technical-writing', 'typescript-best-practices',
  'create-formal-verification-skill', 'maintain-formal-verification-skill',
];
const PLAYBOOKS = ['bug-fix', 'feature', 'refactoring', 'investigation', 'perf-issue', 'prototype', 'opening-a-pr'];

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim();

const tmp = mkdtempSync(join(tmpdir(), 'pstack-'));
try {
  git(tmp, 'clone', '--quiet', '--depth', '1', '--sparse', REPO, 'src'); // one request: a shallow clone, not blob-by-blob
  const src = join(tmp, 'src');
  if (process.argv[2]) git(src, 'checkout', '--quiet', process.argv[2]);
  git(src, 'sparse-checkout', 'set', 'pstack/skills', 'pstack/docs/harness');
  const commit = git(src, 'rev-parse', 'HEAD');
  const from = join(src, 'pstack');

  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(join(DEST, 'skills'), { recursive: true });
  mkdirSync(join(DEST, 'playbooks'), { recursive: true });
  const principles = readdirSync(join(from, 'skills')).filter((n) => n.startsWith('principle-')).sort();
  for (const name of [...SKILLS, ...principles]) {
    if (!existsSync(join(from, 'skills', name, 'SKILL.md'))) throw new Error(`pstack no longer has the skill "${name}"`);
    cpSync(join(from, 'skills', name), join(DEST, 'skills', name), { recursive: true });
  }
  for (const name of PLAYBOOKS) cpSync(join(from, 'skills', 'poteto-mode', 'playbooks', `${name}.md`), join(DEST, 'playbooks', `${name}.md`));
  cpSync(join(from, 'docs', 'harness', 'claude-code.md'), join(DEST, 'claude-code-adapter.md'));
  writeFileSync(join(DEST, 'LICENSE'), `${git(src, 'show', 'HEAD:pstack/LICENSE')}\n`);
  writeFileSync(join(DEST, 'SOURCE.json'), `${JSON.stringify({ repo: 'https://github.com/cursor/plugins', path: 'pstack', commit, skills: SKILLS, principles, playbooks: PLAYBOOKS }, null, 2)}\n`);
  console.log(`vendored ${SKILLS.length} skills, ${principles.length} principles, ${PLAYBOOKS.length} playbooks from ${commit.slice(0, 12)}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
