import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter, rankSkills } from '../src/skills.mjs';

test('frontmatter: plain, quoted and folded values', () => {
  const meta = parseFrontmatter('---\nname: tdd\ndescription: >\n  Test-driven\n  development.\nicon: "x"\n---\nbody');
  assert.deepEqual(meta, { name: 'tdd', description: 'Test-driven development.', icon: 'x' });
  assert.deepEqual(parseFrontmatter('no frontmatter'), {});
});

test('ranking puts the matching skill first and drops non-matches', () => {
  const skills = [
    { name: 'tdd', description: 'Test-driven development with a red-green-refactor loop for bugs and features.' },
    { name: 'to-prd', description: 'Turn a conversation into a product requirements document.' },
    { name: 'diagnose', description: 'Disciplined diagnosis loop for hard bugs and performance regressions.' },
  ];
  const ranked = rankSkills(skills, 'fix this bug test-first with a failing test');
  assert.equal(ranked[0].name, 'tdd');
  assert.ok(!ranked.some((s) => s.name === 'to-prd'));
  assert.deepEqual(rankSkills(skills, 'the and of'), []);
});
