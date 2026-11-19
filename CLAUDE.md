# CLAUDE.md

`orch`: a Node (>=20, ESM, no dependencies) CLI that routes tasks across installed coding agents. Source in `src/*.mjs`, tests in `test/*.test.mjs` (`node:test`), skills in `skills/`, vendored third-party content in `vendor/` (not indexed, don't edit by hand; see `scripts/vendor-pstack.mjs`).

## Tooling: CodeGraph first, rtk for shell output

Two tools are installed to keep context small. Use them in this order:

1. **Understanding or locating code → CodeGraph.** Don't grep or Read first.
2. **Running shell commands → put `rtk` in front of the command.** No rtk hook is installed, so nothing rewrites commands for you. Prefix them yourself.
3. **Plain Read/Grep** only for files CodeGraph doesn't index (Markdown, JSON, `skills/`, `vendor/`, `examples/`) or to confirm one detail.

## CodeGraph (`.codegraph/` index, auto-synced by a daemon)

Indexes `src/`, `test/`, `scripts/` (JS only). The index trails file writes by about a second.

- **Default:** the MCP tool `codegraph_explore`, given a question or a bag of names (`"route pickAgent runner.mjs"`). It returns line-numbered source you can `Edit` from directly, plus call paths and blast radius. Treat that output as already Read and don't re-verify it with grep.
- **Before changing a function**, check its blast radius:
  - `codegraph impact <symbol>` shows what depends on it (`-d 3` goes deeper)
  - `codegraph callers <symbol>` / `codegraph callees <symbol>`
- **Pick which tests to run** after an edit:
  `codegraph affected -q $(git diff --name-only -- src)` gives the test files to run.
- If the MCP tool is unavailable, the shell commands print the same output: `codegraph explore "<query>"`, `codegraph node <symbol|file>`.
- If results look stale: `codegraph sync`. If indexing is blocked: `codegraph unlock`. Check health with `codegraph status`.

## rtk (token-filtering proxy)

rtk prints compact output, and it can recover anything it trimmed. Use it for anything that can produce long output:

| Instead of | Use |
|---|---|
| `npm test` / `node --test test/` | `rtk test npm test` (prints only failures and the summary) |
| one test file | `rtk test node --test test/router.test.mjs` |
| `git status/diff/log/show` | `rtk git status`, `rtk git diff`, `rtk git log -n 10` |
| `gh pr view/checks`, `gh run view` | `rtk gh ...` |
| `grep -rn` / `rg` | `rtk grep` / `rtk rg` (groups matches by file) |
| `find`, `ls`, `tree` | `rtk find`, `rtk ls`, `rtk tree` |
| `cat big.json` | `rtk json file.json` (`--keys-only` shows structure) |
| long logs | `rtk log file`, or `cmd \| rtk pipe` |
| a command where you only care about errors | `rtk err <cmd>` |
| `curl` an API | `rtk curl ...` |

Rules:
- **When rtk elides output**, it prints a recovery hash. Run `rtk recall <hash>` (with `--grep <re>` or `--lines N`) instead of rerunning the command without rtk.
- When you need exact, unfiltered bytes (a patch to apply, output to parse, or a file to hand to another tool), use `rtk bypass <cmd>` or the raw command.
- Don't use `rtk read` on source you intend to `Edit`. Use `codegraph_explore` or Read, which give exact line numbers.
- To review savings: `rtk gain`. To find commands that should have gone through rtk: `rtk discover`.

## Workflow for a code change

1. `codegraph_explore` on the area, then `codegraph impact` on each symbol you'll touch.
2. Make the edit.
3. `codegraph affected -q <changed files>`, then run `rtk test node --test <those files>`.
4. Before finishing, run the full suite: `rtk test npm test`. Review with `rtk git diff`.
