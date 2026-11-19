// "It's done" alerts: a desktop notification, and a webhook if one is set.
import { execFile } from 'node:child_process';

export function notifySettings(config = {}, env = process.env) {
  return {
    desktop: config.notify?.desktop !== false,
    webhook: env.ORCH_NOTIFY_WEBHOOK || config.notify?.webhook || null,
  };
}

function desktop(title, message) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]]
      : ['notify-send', [title, message]];
  return new Promise((resolve) => execFile(cmd, args, (err) => resolve(!err)));
}

// Slack, Discord and most chat webhooks accept one of these two keys.
async function webhook(url, title, message, fetchImpl) {
  const text = `*${title}*\n${message}`;
  const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, content: text }) });
  return res.ok;
}

export async function notify(message, { title = 'orch', settings, fetchImpl = fetch, desktopImpl = desktop } = {}) {
  const sent = [];
  if (settings.desktop && (await desktopImpl(title, message))) sent.push('desktop');
  if (settings.webhook) {
    try {
      if (await webhook(settings.webhook, title, message, fetchImpl)) sent.push('webhook');
    } catch {}
  }
  return sent;
}
