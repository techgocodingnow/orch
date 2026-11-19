// Jira Cloud over REST. The token only ever comes from the environment.
//   JIRA_BASE_URL   https://yourcompany.atlassian.net   (or jira.baseUrl in config)
//   JIRA_EMAIL      you@company.com                     (or jira.email in config)
//   JIRA_API_TOKEN  from id.atlassian.com/manage-profile/security/api-tokens

const FIELDS = 'summary,description,issuetype,status,priority,labels,assignee,reporter,parent,subtasks,issuelinks,comment,attachment';

// Accepts PROJ-123 or a browse URL. Returns { key, baseUrl? }.
export function parseIssueRef(input) {
  const text = String(input ?? '').trim();
  const url = /^(https?:\/\/[^/\s]+)\/.*?\b([A-Z][A-Z0-9_]+-\d+)\b/.exec(text);
  if (url) return { key: url[2], baseUrl: url[1] };
  const key = /^[A-Z][A-Z0-9_]+-\d+$/.exec(text);
  return key ? { key: key[0] } : null;
}

// First Jira key mentioned anywhere in free text, e.g. a slash-command argument.
export function findIssueRef(text) {
  for (const word of String(text ?? '').split(/\s+/)) {
    const ref = parseIssueRef(word.replace(/[),.;]+$/, ''));
    if (ref) return ref;
  }
  return null;
}

export function jiraSettings(config = {}, env = process.env) {
  return {
    baseUrl: (env.JIRA_BASE_URL || config.jira?.baseUrl || '').replace(/\/+$/, ''),
    email: env.JIRA_EMAIL || config.jira?.email || '',
    token: env.JIRA_API_TOKEN || '',
  };
}

export function missingSettings(settings) {
  return [
    !settings.baseUrl && 'JIRA_BASE_URL',
    !settings.email && 'JIRA_EMAIL',
    !settings.token && 'JIRA_API_TOKEN',
  ].filter(Boolean);
}

async function request(settings, path, { method = 'GET', body, fetchImpl = fetch } = {}) {
  const missing = missingSettings(settings);
  if (missing.length) throw new Error(`Jira is not configured. Missing ${missing.join(', ')}. Run \`orch setup\`.`);
  const res = await fetchImpl(`${settings.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${settings.email}:${settings.token}`).toString('base64')}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const hint = { 401: 'check JIRA_EMAIL and JIRA_API_TOKEN', 403: 'this account cannot see it', 404: 'no such issue, or no permission to see it' }[res.status];
    throw new Error(`Jira ${method} ${path} failed: ${res.status}${hint ? ` (${hint})` : ''}`);
  }
  return res.status === 204 ? null : res.json();
}

// Atlassian Document Format to plain markdown-ish text.
export function adfToText(node, depth = 0) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  const kids = (sep = '') => (node.content ?? []).map((c) => adfToText(c, depth)).join(sep);
  switch (node.type) {
    case 'doc':
      return kids('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    case 'text': {
      let text = node.text ?? '';
      for (const mark of node.marks ?? []) {
        if (mark.type === 'code') text = `\`${text}\``;
        else if (mark.type === 'strong') text = `**${text}**`;
        else if (mark.type === 'link' && mark.attrs?.href && mark.attrs.href !== text) text = `[${text}](${mark.attrs.href})`;
      }
      return text;
    }
    case 'paragraph':
      return kids();
    case 'heading':
      return `${'#'.repeat(node.attrs?.level ?? 2)} ${kids()}`;
    case 'hardBreak':
      return '\n';
    case 'rule':
      return '---';
    case 'blockquote':
      return kids('\n').split('\n').map((l) => `> ${l}`).join('\n');
    case 'codeBlock':
      return `\`\`\`${node.attrs?.language ?? ''}\n${kids()}\n\`\`\``;
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return (node.content ?? [])
        .map((item, i) => {
          const mark = node.type === 'orderedList' ? `${i + 1}.` : item.type === 'taskItem' ? (item.attrs?.state === 'DONE' ? '- [x]' : '- [ ]') : '-';
          const body = (item.content ?? []).map((c) => adfToText(c, depth + 1)).join('\n');
          return `${'  '.repeat(depth)}${mark} ${body.replace(/^\s+/, '')}`;
        })
        .join('\n');
    case 'table':
      return (node.content ?? []).map((row) => `| ${(row.content ?? []).map((cell) => adfToText({ type: 'paragraph', content: cell.content?.flatMap((c) => c.content ?? []) })).join(' | ')} |`).join('\n');
    case 'mention':
      return node.attrs?.text ?? '@someone';
    case 'emoji':
      return node.attrs?.text ?? node.attrs?.shortName ?? '';
    case 'inlineCard':
    case 'blockCard':
      return node.attrs?.url ?? '';
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media':
      return '[attachment]';
    default:
      return kids();
  }
}

export function normalizeIssue(raw, baseUrl) {
  const f = raw.fields ?? {};
  return {
    key: raw.key,
    url: `${baseUrl}/browse/${raw.key}`,
    summary: f.summary ?? '',
    type: f.issuetype?.name ?? '',
    status: f.status?.name ?? '',
    priority: f.priority?.name ?? '',
    labels: f.labels ?? [],
    assignee: f.assignee?.displayName ?? null,
    reporter: f.reporter?.displayName ?? null,
    parent: f.parent ? { key: f.parent.key, summary: f.parent.fields?.summary ?? '' } : null,
    description: adfToText(f.description),
    subtasks: (f.subtasks ?? []).map((s) => ({ key: s.key, summary: s.fields?.summary ?? '', status: s.fields?.status?.name ?? '' })),
    links: (f.issuelinks ?? []).map((l) => {
      const other = l.outwardIssue ?? l.inwardIssue;
      return { relation: l.outwardIssue ? l.type?.outward : l.type?.inward, key: other?.key, summary: other?.fields?.summary ?? '' };
    }),
    attachments: (f.attachment ?? []).map((a) => ({ name: a.filename, url: a.content })),
    comments: (f.comment?.comments ?? []).map((c) => ({ author: c.author?.displayName ?? '', at: c.created, body: adfToText(c.body) })),
  };
}

export function renderIssue(issue) {
  const lines = [`# ${issue.key}: ${issue.summary}`, '', `${issue.type} · ${issue.status}${issue.priority ? ` · ${issue.priority}` : ''}`, issue.url];
  if (issue.parent) lines.push(`Parent: ${issue.parent.key} ${issue.parent.summary}`);
  if (issue.labels.length) lines.push(`Labels: ${issue.labels.join(', ')}`);
  lines.push('', '## Description', '', issue.description || '(empty)');
  const list = (title, items, fmt) => items.length && lines.push('', `## ${title}`, '', ...items.map(fmt));
  list('Subtasks', issue.subtasks, (s) => `- ${s.key} [${s.status}] ${s.summary}`);
  list('Links', issue.links, (l) => `- ${l.relation} ${l.key} ${l.summary}`);
  list('Attachments', issue.attachments, (a) => `- ${a.name}`);
  list('Comments', issue.comments, (c) => `**${c.author}** (${c.at?.slice(0, 10)}):\n${c.body}\n`);
  return `${lines.join('\n')}\n`;
}

export async function getIssue(ref, settings, opts) {
  const s = ref.baseUrl && !settings.baseUrl ? { ...settings, baseUrl: ref.baseUrl } : settings;
  const raw = await request(s, `/rest/api/3/issue/${ref.key}?fields=${FIELDS}`, opts);
  return normalizeIssue(raw, s.baseUrl);
}

export async function whoami(settings, opts) {
  const me = await request(settings, '/rest/api/3/myself', opts);
  return me.displayName ?? me.emailAddress ?? 'ok';
}

export async function addComment(key, text, settings, opts) {
  const content = text.split(/\n{2,}/).map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] }));
  await request(settings, `/rest/api/3/issue/${key}/comment`, { ...opts, method: 'POST', body: { body: { type: 'doc', version: 1, content } } });
}
