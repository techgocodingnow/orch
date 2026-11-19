// Pull the user's own typed messages out of Claude Code and Codex transcripts,
// so a skill can learn how they work without reading whole sessions.
// Scoped to one project unless the caller asks for all of them.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_TEXT = 1500;

// Text the harness injects around what the user typed.
function clean(text) {
  let t = String(text ?? '');
  const request = t.indexOf('## My request for Codex:');
  if (request >= 0) t = t.slice(request + 24);
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/\[Image[^\]]*\]/g, '').trim();
  if (!t || /^(<|# AGENTS\.md|# Files mentioned|Caveat:|\[Request interrupted|Base directory for this skill|Name this chat from|This session is being continued)/.test(t)) return '';
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)} […]` : t;
}

function lines(path) {
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

const recent = (path, since) => {
  try {
    return statSync(path).mtimeMs >= since;
  } catch {
    return false;
  }
};

export function claudeMessages({ cwd, all, since, home = homedir() }) {
  const root = join(home, '.claude', 'projects');
  if (!existsSync(root)) return [];
  // Claude Code names a project folder after its path, with / and . as dashes.
  const dirs = all ? readdirSync(root) : [cwd.replace(/[/.]/g, '-')];
  const out = [];
  for (const dir of dirs) {
    const full = join(root, dir);
    if (!existsSync(full)) continue;
    for (const file of readdirSync(full).filter((f) => f.endsWith('.jsonl'))) {
      const path = join(full, file);
      if (!recent(path, since)) continue;
      for (const row of lines(path)) {
        if (row.type !== 'user' || row.isSidechain || row.isMeta || row.toolUseResult) continue;
        const content = row.message?.content;
        const parts = typeof content === 'string' ? [content] : (content ?? []).filter((b) => b.type === 'text').map((b) => b.text);
        const text = parts.map(clean).filter(Boolean).join('\n');
        if (text) out.push({ agent: 'claude', session: row.sessionId ?? file, project: row.cwd ?? dir, at: row.timestamp ?? '', text });
      }
    }
  }
  return out;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.jsonl') ? [join(dir, e.name)] : []));
}

export function codexMessages({ cwd, all, since, home = homedir() }) {
  const out = [];
  for (const path of walk(join(process.env.CODEX_HOME || join(home, '.codex'), 'sessions'))) {
    if (!recent(path, since)) continue;
    const rows = lines(path);
    const meta = rows.find((r) => r.type === 'session_meta')?.payload ?? {};
    // Headless runs are our own workers, not the user talking.
    if (meta.originator === 'codex_exec') continue;
    if (!all && meta.cwd !== cwd) continue;
    for (const row of rows) {
      const p = row.payload ?? {};
      if (row.type !== 'response_item' || p.type !== 'message' || p.role !== 'user') continue;
      const text = (p.content ?? []).filter((b) => b.type === 'input_text').map((b) => clean(b.text)).filter(Boolean).join('\n');
      if (text) out.push({ agent: 'codex', session: meta.id ?? path, project: meta.cwd ?? '', at: row.timestamp ?? '', text });
    }
  }
  return out;
}

export function collect({ cwd = process.cwd(), all = false, days = 30, home } = {}) {
  const since = Date.now() - days * 86_400_000;
  const cutoff = new Date(since).toISOString();
  return [...claudeMessages({ cwd, all, since, home }), ...codexMessages({ cwd, all, since, home })]
    .filter((m) => !m.at || m.at >= cutoff)
    .sort((a, b) => a.at.localeCompare(b.at));
}

export function render(messages) {
  const out = [];
  let session = null;
  for (const m of messages) {
    if (m.session !== session) {
      session = m.session;
      out.push(`\n=== ${m.agent} · ${m.at.slice(0, 10)} · ${m.project}`);
    }
    out.push(`> ${m.text.replace(/\n/g, '\n  ')}`);
  }
  return out.join('\n').trim();
}
