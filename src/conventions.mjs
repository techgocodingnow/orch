// Branch names, commit messages and PR titles, after commitlint's
// config-conventional, plus one rule of our own: the Jira key appears in each,
// so Jira's development panel links the branch, the commits and the PR.
//
//   branch      feat/ACME-412-add-rate-limiting
//   commit      feat(api): add rate limiting      ...  Refs: ACME-412
//   PR title    feat(api): add rate limiting (ACME-412)
//
// A repo that has its own commitlint config keeps its own rules: JSON configs
// are read here, and any other config is handed to the repo's own commitlint.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_TYPES = ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'style', 'test'];
export const DEFAULT_RULES = { types: DEFAULT_TYPES, headerMax: 100, lineMax: 100 };

const KEY = /\b[A-Z][A-Z0-9_]+-\d+\b/;
const HEADER = /^(?<type>[^\s(!:]+)(?:\((?<scope>[^)]*)\))?(?<breaking>!)?: (?<subject>.*)$/;
// Messages commitlint skips by default: git's own merges and reverts, autosquash markers.
const IGNORED = [/^Merge (branch|pull request|remote-tracking branch|tag) /, /^Merge .+ into .+/, /^Revert ".+"/, /^(fixup|squash|amend)! /];

const JSON_CONFIGS = ['.commitlintrc', '.commitlintrc.json'];
const OTHER_CONFIGS = ['.commitlintrc.yaml', '.commitlintrc.yml', '.commitlintrc.js', '.commitlintrc.cjs', '.commitlintrc.mjs', '.commitlintrc.ts', 'commitlint.config.js', 'commitlint.config.cjs', 'commitlint.config.mjs', 'commitlint.config.ts'];

export function findKey(text) {
  return KEY.exec(String(text ?? ''))?.[0] ?? null;
}

// Rules from the repo's commitlint config where we can read them, else the
// conventional defaults. `delegate` names a config only the repo's commitlint can read.
export function loadRules(cwd = process.cwd()) {
  const rules = { ...DEFAULT_RULES, source: 'conventional defaults', delegate: null };
  let config = null;
  for (const name of JSON_CONFIGS) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    try {
      config = JSON.parse(readFileSync(path, 'utf8'));
      rules.source = name;
    } catch {
      rules.delegate = name;
    }
    break;
  }
  if (!config && !rules.delegate) {
    const other = OTHER_CONFIGS.find((name) => existsSync(join(cwd, name)));
    if (other) rules.delegate = other;
  }
  if (!config && !rules.delegate) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
      if (pkg.commitlint) {
        config = pkg.commitlint;
        rules.source = 'package.json';
      }
    } catch {}
  }
  const value = (name) => {
    const r = config?.rules?.[name];
    // [level, 'always' | 'never', value]; level 0 turns the rule off.
    return Array.isArray(r) && r[0] > 0 && r[1] !== 'never' ? r[2] : undefined;
  };
  if (Array.isArray(value('type-enum'))) rules.types = value('type-enum');
  if (Number(value('header-max-length')) > 0) rules.headerMax = Number(value('header-max-length'));
  if (Number(value('body-max-line-length')) > 0) rules.lineMax = Number(value('body-max-line-length'));
  if (Array.isArray(value('scope-enum')) && value('scope-enum').length) rules.scopes = value('scope-enum');
  return rules;
}

export function parseHeader(header) {
  const m = HEADER.exec(String(header ?? '').trim());
  return m ? { type: m.groups.type, scope: m.groups.scope ?? null, breaking: Boolean(m.groups.breaking), subject: m.groups.subject } : null;
}

function headerProblems(header, rules) {
  const out = [];
  if (header.length > rules.headerMax) out.push(`header is ${header.length} characters, the limit is ${rules.headerMax}`);
  const h = parseHeader(header);
  if (!h) return [...out, `header must read "<type>(<scope>): <subject>", got "${header}"`];
  if (!rules.types.includes(h.type)) out.push(`type "${h.type}" is not one of: ${rules.types.join(', ')}`);
  if (h.scope != null && !h.scope.trim()) out.push('scope is empty: drop the parentheses or name the scope');
  if (h.scope && rules.scopes && !h.scope.split(/[,/]/).every((s) => rules.scopes.includes(s.trim()))) out.push(`scope "${h.scope}" is not one of: ${rules.scopes.join(', ')}`);
  if (!h.subject.trim()) out.push('subject is empty');
  else {
    if (/^[A-Z][a-z]/.test(h.subject)) out.push('subject starts with a capital letter: write "add x", not "Add x"');
    if (/\.$/.test(h.subject.trim())) out.push('subject ends with a full stop');
  }
  return out;
}

// Problems with one commit message; an empty list means it passes.
export function lintCommit(message, { rules = DEFAULT_RULES, key } = {}) {
  const text = String(message ?? '').replace(/\r\n/g, '\n').replace(/^#.*\n?/gm, '').trimEnd();
  const [header = '', ...rest] = text.split('\n');
  if (IGNORED.some((re) => re.test(header))) return [];
  const out = headerProblems(header, rules);
  if (rest.length && rest[0].trim()) out.push('leave a blank line between the header and the body');
  for (const line of rest) {
    if (line.length > rules.lineMax && !line.includes('://')) out.push(`body line is ${line.length} characters, the limit is ${rules.lineMax}: "${line.slice(0, 40)}…"`);
  }
  if (key && !new RegExp(`\\b${key}\\b`).test(text)) out.push(`does not mention ${key}: add a "Refs: ${key}" footer so Jira links it`);
  return out;
}

// The PR title becomes the commit on the main branch when the PR is squashed,
// so it follows the commit header rules and carries the key itself.
export function lintPrTitle(title, { rules = DEFAULT_RULES, key } = {}) {
  const out = headerProblems(String(title ?? '').trim(), rules);
  if (key && !String(title).includes(key)) out.push(`does not mention ${key}: end it with "(${key})" so Jira links the PR`);
  return out;
}

export function slugify(text, max = 40) {
  const words = String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let slug = '';
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > max) break;
    slug = next;
  }
  return slug || words[0]?.slice(0, max) || '';
}

// <type>/<KEY>-<slug>, or <type>/<slug> when there is no ticket. Jira matches
// the key only in capitals, so it stays upper case inside a lower-case name.
export function branchName({ type, key, summary }, rules = DEFAULT_RULES) {
  if (!rules.types.includes(type)) throw new Error(`type "${type}" is not one of: ${rules.types.join(', ')}`);
  if (key && !findKey(key)) throw new Error(`"${key}" is not a Jira key like PROJ-123`);
  const slug = slugify(summary);
  if (!slug) throw new Error('give a short summary for the branch name');
  return `${type}/${key ? `${key}-` : ''}${slug}`;
}

export function lintBranch(name, { rules = DEFAULT_RULES, key } = {}) {
  const m = /^(?<type>[^/]+)\/(?<key>[A-Z][A-Z0-9_]+-\d+-)?(?<slug>[a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(String(name ?? ''));
  if (!m) return [`branch "${name}" must read "<type>/<KEY>-<short-slug>" (or "<type>/<short-slug>" without a ticket), lower case apart from the key`];
  const out = [];
  if (!rules.types.includes(m.groups.type)) out.push(`branch type "${m.groups.type}" is not one of: ${rules.types.join(', ')}`);
  if (key && !String(name).includes(`/${key}-`)) out.push(`branch does not carry ${key}: name it ${m.groups.type}/${key}-${m.groups.slug}`);
  return out;
}
