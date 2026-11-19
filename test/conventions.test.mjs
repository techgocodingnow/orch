import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { branchName, lintBranch, lintCommit, lintPrTitle, loadRules, slugify, DEFAULT_RULES } from '../src/conventions.mjs';

test('branch names carry the type and the Jira key in capitals', () => {
  assert.equal(branchName({ type: 'feat', key: 'ACME-412', summary: 'Add rate limiting to the public API!' }), 'feat/ACME-412-add-rate-limiting-to-the-public-api');
  assert.equal(branchName({ type: 'fix', summary: 'Rename the Store type' }), 'fix/rename-the-store-type');
  assert.throws(() => branchName({ type: 'feature', summary: 'x' }), /not one of/);
  assert.throws(() => branchName({ type: 'feat', key: 'acme-1', summary: 'x' }), /Jira key/);
  assert.ok(slugify('one two three four five six seven eight nine ten eleven').length <= 40);
});

test('a branch is checked for its shape, its type and the ticket key', () => {
  assert.deepEqual(lintBranch('feat/ACME-412-rate-limit', { key: 'ACME-412' }), []);
  assert.deepEqual(lintBranch('chore/bump-deps'), []);
  assert.match(lintBranch('ACME-412-rate-limit')[0], /must read/);
  assert.match(lintBranch('feat/acme-412-rate-limit', { key: 'ACME-412' })[0], /does not carry ACME-412/);
  assert.match(lintBranch('feature/ACME-412-x')[0], /not one of/);
});

test('commit messages follow the conventional rules and name the key', () => {
  assert.deepEqual(lintCommit('feat(api): add rate limiting\n\nCounts requests per user.\n\nRefs: ACME-412', { key: 'ACME-412' }), []);
  assert.deepEqual(lintCommit('fix!: drop the v1 endpoint'), []);
  const bad = lintCommit('Feat: Add rate limiting.\nno blank line', { key: 'ACME-412' });
  assert.equal(bad.length, 5, bad.join('\n'));
  assert.match(lintCommit(`feat: ${'x'.repeat(120)}`)[0], /limit is 100/);
  assert.deepEqual(lintCommit("Merge branch 'main' into feat/x"), []);
  assert.deepEqual(lintCommit('fixup! feat: add x'), []);
  assert.deepEqual(lintCommit('docs: link\n\nhttps://example.com/' + 'a'.repeat(120)), []);
});

test('the PR title is a commit header with the key in it', () => {
  assert.deepEqual(lintPrTitle('feat(api): add rate limiting (ACME-412)', { key: 'ACME-412' }), []);
  assert.match(lintPrTitle('feat(api): add rate limiting', { key: 'ACME-412' })[0], /\(ACME-412\)/);
});

test("a repo's own commitlint config wins", () => {
  const dir = mkdtempSync(join(tmpdir(), 'orch-cl-'));
  assert.equal(loadRules(dir).source, 'conventional defaults');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ commitlint: { rules: { 'type-enum': [2, 'always', ['feat', 'fix', 'wip']], 'header-max-length': [2, 'always', 72] } } }));
  const rules = loadRules(dir);
  assert.deepEqual(rules.types, ['feat', 'fix', 'wip']);
  assert.equal(rules.headerMax, 72);
  assert.deepEqual(lintCommit('wip: try it', { rules }), []);
  assert.match(lintCommit('docs: x', { rules })[0], /not one of/);
  writeFileSync(join(dir, 'commitlint.config.js'), 'export default {}');
  assert.equal(loadRules(dir).delegate, 'commitlint.config.js');
  assert.deepEqual(loadRules(dir).types, DEFAULT_RULES.types);
});
