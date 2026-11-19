// Agent adapters: detect which coding-agent CLIs are usable and run one task
// through one of them in headless mode.
import { spawn } from 'node:child_process';
import { createWriteStream, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Workers build and commit. Publishing and history rewrites stay with the
// orchestrator and the human, so a worker cannot reach them at all.
export const WORKER_DENIED = 'Bash(git push:*) Bash(git reset --hard:*) Bash(git clean:*) Bash(git branch -D:*) Bash(git checkout .:*) Bash(git restore .:*) Bash(gh pr merge:*) Bash(gh pr create:*)';
const READ_TOOLS = 'Read Grep Glob WebSearch WebFetch Bash(git log:*) Bash(git diff:*) Bash(git show:*) Bash(git status:*) Bash(ls:*) Bash(rg:*) Bash(cat:*)';

function exec(cmd, args, { timeoutMs = 10_000, input } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: 127, out: String(err) });
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, out: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
    child.stdin.end(input ?? '');
  });
}

export const ADAPTERS = {
  claude: {
    bin: 'claude',
    async auth() {
      // Claude Code has no cheap offline login probe; a failed run reports it.
      return { ok: true };
    },
    command({ model, effort, mode, maxUsd }) {
      const args = ['-p', '--output-format', 'json', '--no-session-persistence'];
      if (model) args.push('--model', model);
      if (effort) args.push('--effort', effort);
      if (maxUsd != null) args.push('--max-budget-usd', String(maxUsd));
      if (mode === 'write') args.push('--permission-mode', 'acceptEdits', '--allowedTools', `${READ_TOOLS} Edit Write Bash`, '--disallowedTools', WORKER_DENIED);
      else args.push('--permission-mode', 'dontAsk', '--allowedTools', READ_TOOLS);
      return { args, stdin: true };
    },
    parse(stdout) {
      const data = JSON.parse(stdout.slice(stdout.indexOf('{')));
      const u = data.usage ?? {};
      return {
        ok: !data.is_error,
        text: data.result ?? '',
        usd: data.total_cost_usd ?? null,
        usdSource: 'reported',
        tokens: {
          in: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
          out: u.output_tokens ?? 0,
        },
        error: !data.is_error ? null : data.subtype === 'error_max_budget_usd' ? 'hit its cost cap' : data.result || data.subtype,
      };
    },
  },

  codex: {
    bin: 'codex',
    async auth() {
      const r = await exec('codex', ['login', 'status']);
      if (r.code !== 0) return { ok: false, reason: 'not logged in (run `codex login`)' };
      // The model in config.toml may not be one this account can run headless.
      const configPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml');
      const configured = existsSync(configPath) ? /^model\s*=\s*"([^"]+)"/m.exec(readFileSync(configPath, 'utf8'))?.[1] : null;
      const listed = await exec('/bin/sh', ['-c', 'codex debug models 2>/dev/null']);
      let models = [];
      try {
        const data = JSON.parse(listed.out);
        models = (data.models ?? data).filter((m) => m.visibility === 'list').map((m) => m.slug);
      } catch {}
      if (!configured || !models.length || models.includes(configured)) return { ok: true, models };
      return {
        ok: true,
        models,
        fallbackModel: models[0],
        note: `config.toml model "${configured}" is not available to this account, using ${models[0]}`,
      };
    },
    command({ model, effort, mode, cwd, resultPath }) {
      const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '-o', resultPath];
      args.push('-s', mode === 'write' ? 'workspace-write' : 'read-only');
      if (model) args.push('-m', model);
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
      args.push('-');
      return { args, stdin: true };
    },
    parse(stdout, { resultPath, price }) {
      const tokens = { in: 0, cached: 0, out: 0 };
      let error = null;
      let last = '';
      for (const line of stdout.split('\n')) {
        if (!line.startsWith('{')) continue;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        const usage = ev.usage ?? ev.msg?.usage;
        if (usage) {
          tokens.in += usage.input_tokens ?? 0;
          tokens.cached += usage.cached_input_tokens ?? 0;
          tokens.out += usage.output_tokens ?? 0;
        }
        if (ev.type === 'error' || ev.type === 'turn.failed') error = ev.message ?? ev.error?.message ?? 'codex error';
        if (ev.item?.type === 'agent_message' && ev.item.text) last = ev.item.text;
      }
      const text = existsSync(resultPath) ? readFileSync(resultPath, 'utf8') : last;
      const fresh = Math.max(0, tokens.in - tokens.cached);
      const usd = price ? (fresh * price.in + tokens.cached * price.in * 0.1 + tokens.out * price.out) / 1e6 : null;
      return { ok: !error && Boolean(text), text, usd, usdSource: 'computed-from-tokens', tokens: { in: tokens.in, out: tokens.out }, error };
    },
  },

  cursor: {
    bin: 'cursor-agent',
    async auth() {
      const r = await exec('cursor-agent', ['status']);
      return /not logged in/i.test(r.out) || r.code !== 0
        ? { ok: false, reason: 'not logged in (run `cursor-agent login`)' }
        : { ok: true };
    },
    command({ model, mode, cwd, prompt }) {
      const args = ['-p', '--output-format', 'json', '--trust', '--workspace', cwd];
      if (model && model !== 'auto') args.push('--model', model);
      args.push(...(mode === 'write' ? ['--force'] : ['--mode', 'ask']));
      args.push(prompt);
      return { args, stdin: false };
    },
    parse(stdout) {
      const data = JSON.parse(stdout.slice(stdout.indexOf('{')));
      return { ok: !data.is_error, text: data.result ?? '', usd: null, usdSource: 'unknown', tokens: null, error: data.is_error ? data.result : null };
    },
  },
};

export async function detect(config = { agents: {} }) {
  const checks = Object.entries(ADAPTERS).map(async ([name, adapter]) => {
    if (config.agents?.[name]?.enabled === false) return { name, available: false, reason: 'off (enable in config)' };
    const which = await exec('/bin/sh', ['-c', `command -v ${adapter.bin}`]);
    if (which.code !== 0) return { name, available: false, reason: 'not installed' };
    const [version, auth] = await Promise.all([exec(adapter.bin, ['--version']), adapter.auth()]);
    return {
      name,
      available: auth.ok,
      reason: auth.ok ? null : auth.reason,
      note: auth.note,
      models: auth.models,
      fallbackModel: auth.fallbackModel,
      path: which.out.trim(),
      version: version.out.split('\n').find((l) => /\d+\.\d+/.test(l) && !/warning/i.test(l))?.trim() ?? '',
    };
  });
  return Promise.all(checks);
}

// Run one task. Never throws: failures come back as { ok: false, error }.
export function invoke({ assignment, mode, cwd, prompt, maxUsd, timeoutMs, logPath, resultPath, price }) {
  const adapter = ADAPTERS[assignment.agent];
  const { args, stdin } = adapter.command({ ...assignment, mode, cwd, prompt, maxUsd, resultPath });
  const started = Date.now();
  return new Promise((resolve) => {
    const log = createWriteStream(logPath);
    log.write(`$ ${adapter.bin} ${args.map((a) => (a === prompt ? '<prompt>' : a)).join(' ')}\n\n`);
    const child = spawn(adapter.bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      stdout += d;
      log.write(d);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      log.write(d);
    });
    const finish = (result) => {
      clearTimeout(timer);
      log.end();
      resolve({ ...result, durationMs: Date.now() - started });
    };
    child.on('error', (err) => finish({ ok: false, text: '', usd: null, error: String(err) }));
    child.on('close', (code) => {
      if (timedOut) return finish({ ok: false, text: '', usd: null, error: `timed out after ${Math.round(timeoutMs / 60000)} min` });
      let parsed;
      try {
        parsed = adapter.parse(stdout, { resultPath, price });
      } catch {
        parsed = { ok: false, text: stdout.trim(), usd: null, error: `could not parse ${assignment.agent} output` };
      }
      if (code !== 0 && parsed.ok) parsed = { ...parsed, ok: false, error: `exit code ${code}` };
      if (!parsed.ok && !parsed.error) parsed.error = stderr.trim().split('\n').pop() || `exit code ${code}`;
      finish(parsed);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin ? prompt : '');
  });
}

export function describeCommand({ assignment, mode, cwd }) {
  const adapter = ADAPTERS[assignment.agent];
  const { args } = adapter.command({ ...assignment, mode, cwd, prompt: '<prompt>', maxUsd: null, resultPath: '<result>' });
  return `${adapter.bin} ${args.join(' ')}`;
}
