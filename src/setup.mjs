// One-time setup check: agents, GitHub, the Jira connector in each agent, alerts.
// Writes a stamp so later runs can skip straight to work.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { detect } from './agents.mjs';
import { jiraSettings, missingSettings, whoami } from './jira.mjs';
import { notifySettings } from './notify.mjs';

const ATLASSIAN_MCP = 'https://mcp.atlassian.com/v1/mcp';

export const stampPath = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'orch', 'setup.json');

function sh(cmd, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}` });
    });
  });
}

// Each agent brings its own Atlassian connector. Read its state from the
// agent's MCP listing: connected, needs-login, or missing.
export function connectorState(agent, listing, codexConfig = '') {
  const line = listing.split('\n').find((l) => /atlassian|jira/i.test(l));
  if (agent === 'claude') {
    if (!line) return 'missing';
    return /connected/i.test(line) && !/needs auth|failed/i.test(line) ? 'connected' : 'needs-login';
  }
  // Codex: an MCP server, or an Atlassian/Jira plugin enabled in config.toml.
  if (line) return /not logged in|unauth|needs/i.test(line) ? 'needs-login' : 'connected';
  return /^\[plugins\."[^"]*(atlassian|jira)[^"]*"\]\s*\n\s*enabled\s*=\s*true/im.test(codexConfig) ? 'connected' : 'missing';
}

const CONNECT_HELP = {
  claude: {
    missing: `Add it: claude mcp add --transport http atlassian ${ATLASSIAN_MCP}   then run /mcp in Claude Code and sign in. Or enable the Atlassian connector at claude.ai/settings/connectors.`,
    'needs-login': 'Run /mcp in Claude Code, pick Atlassian, and sign in.',
  },
  codex: {
    missing: `Add it: codex mcp add atlassian --url ${ATLASSIAN_MCP}   then: codex mcp login atlassian`,
    'needs-login': 'Run: codex mcp login atlassian',
  },
};

async function jiraChecks(agents, config) {
  const checks = [];
  const lists = { claude: ['claude', ['mcp', 'list']], codex: ['codex', ['mcp', 'list']] };
  await Promise.all(
    agents
      .filter((a) => a.available && lists[a.name])
      .map(async (a) => {
        const listing = await sh(...lists[a.name]);
        const codexToml = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
        const state = connectorState(a.name, listing.out, a.name === 'codex' && existsSync(codexToml) ? readFileSync(codexToml, 'utf8') : '');
        checks.push({
          name: `jira connector in ${a.name}`,
          ok: state === 'connected',
          required: false,
          detail: state === 'connected' ? 'Atlassian connected' : state,
          fix: CONNECT_HELP[a.name][state],
        });
      }),
  );
  // Optional fallback for headless use: Jira REST with an API token.
  const settings = jiraSettings(config);
  if (!missingSettings(settings).length) {
    try {
      checks.push({ name: 'jira api token', ok: true, required: false, detail: `signed in as ${await whoami(settings)}` });
    } catch (err) {
      checks.push({ name: 'jira api token', ok: false, required: false, detail: err.message, fix: 'Check JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN.' });
    }
  }
  return checks.sort((a, b) => a.name.localeCompare(b.name));
}

export async function runSetup(config) {
  const agents = await detect(config);
  const ready = agents.filter((a) => a.available);
  const checks = [];
  for (const a of agents) {
    if (a.reason === 'off (enable in config)') continue;
    checks.push({ name: `agent ${a.name}`, ok: a.available, required: false, detail: a.available ? a.version : a.reason, fix: a.available ? undefined : `Install or log in to ${a.name}.`, note: a.note });
  }
  checks.push({ name: 'at least one agent', ok: ready.length > 0, required: true, detail: ready.map((a) => a.name).join(', ') || 'none ready', fix: 'Install Claude Code or Codex and log in.' });

  // `gh auth status` fails if any saved account is stale, so ask who we are instead.
  const [git, gh] = await Promise.all([sh('git', ['--version']), sh('gh', ['api', 'user', '--jq', '.login'])]);
  checks.push({ name: 'git', ok: git.ok, required: true, detail: git.ok ? git.out.trim() : 'not installed', fix: 'Install git.' });
  const account = gh.out.trim();
  checks.push({ name: 'github (gh)', ok: gh.ok, required: true, detail: gh.ok ? `logged in as ${account ?? '?'}` : 'not logged in', fix: 'Install the GitHub CLI and run: gh auth login' });

  checks.push(...(await jiraChecks(agents, config)));

  const n = notifySettings(config);
  checks.push({ name: 'alerts', ok: true, required: false, detail: [n.desktop && 'desktop notification', n.webhook && 'webhook'].filter(Boolean).join(' + ') || 'off' });

  const ok = checks.every((c) => c.ok || !c.required);
  const result = { ok, at: new Date().toISOString(), checks };
  if (ok) {
    mkdirSync(dirname(stampPath()), { recursive: true });
    writeFileSync(stampPath(), JSON.stringify(result, null, 2));
  }
  return result;
}

export function readStamp() {
  try {
    return JSON.parse(readFileSync(stampPath(), 'utf8'));
  } catch {
    return null;
  }
}

// Merge a few keys into the user's config file.
export function saveUserConfig(patch) {
  const path = join(dirname(stampPath()), 'config.json');
  const current = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete current[key];
    else if (value === null || typeof value !== 'object') current[key] = value;
    else current[key] = Object.fromEntries(Object.entries({ ...(current[key] ?? {}), ...value }).filter(([, v]) => v !== null && v !== ''));
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
  return path;
}
