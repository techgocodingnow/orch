# orch in Claude Code

How to install `orch` for Claude Code, what it adds, and how Claude Code runs it.

`orch` is two things: a set of skills that tell Claude what to do, and a small CLI those skills call. Claude Code plays two roles. The session you type into is the **orchestrator**. The sub-sessions that do each task are **workers**, started headless by `orch run`.

## Install

Needs Node 20 or later, the `claude` CLI logged in, and the GitHub CLI (`gh`) logged in.

```
git clone https://github.com/techgocodingnow/orch.git
cd orch
node src/cli.mjs install
```

This does two things, and never overwrites a file it did not create:

- Links each skill folder under `skills/` into `~/.claude/skills/`.
- Writes a launcher at `~/.local/bin/orch`. That folder must be on your `PATH`.

Keep the clone: the links and the launcher point into it. To update, `git pull` in the clone and start a new Claude Code session. `orch uninstall` removes exactly what `install` added.

Start a **new** Claude Code session after installing. A session lists its skills when it starts.

## First run

In Claude Code:

```
/orch-setup
```

It runs `orch setup` and walks you through whatever is missing. For Jira, Claude Code reads tickets through its own Atlassian connector, so there is no token to manage: run `/mcp`, pick Atlassian, and sign in. If Atlassian is not listed, enable it at claude.ai/settings/connectors.

Then, once per project you want end-to-end checks in:

```
/orch-verify
```

## The skills

| Type this | What it does |
|---|---|
| `/orchestrate PROJ-123` | Takes a ticket through six stages to a PR that is ready to merge. Also accepts a Jira URL or a task in plain words. |
| `/orch-setup` | One-time check of agents, GitHub, the Jira connector, alerts and approval mode. |
| `/orch-verify` | Builds or maintains this project's `verify-<app>` skill: how to start the app and prove a feature. |
| `/orch-retro` | After a run, proposes checks and standards so the same mistake cannot recur. |
| `/orch-eval` | Blinded comparison of two versions of a skill, prompt or model choice. |
| `/orch-me` | Drafts your own `<name>-mode` skill from how you have worked. |

Flags for `/orchestrate`, all optional:

```
/orchestrate PROJ-123 --budget 5 --profile balanced --approve observe
/orchestrate --no-pr rename the Store type everywhere
```

| Flag | Meaning |
|---|---|
| `--profile cheap\|balanced\|fast` | Trade quality for cost or speed. Unset means best quality. |
| `--budget <usd>` | Cap for the whole plan. |
| `--approve human\|observe\|auto` | Who approves a PR that passed. Default `human`. |
| `--no-pr` | Stop before opening a pull request. |
| `--no-alert` | Do not send the finished alert. |

## Permissions

The orchestrator calls `orch` through the Bash tool, so Claude Code asks for permission the first time. To allow it for a project, add this to `.claude/settings.json` in that project:

```json
{
  "permissions": {
    "allow": ["Bash(orch:*)"]
  }
}
```

`orch run` blocks until every task has ended, which can take many minutes. Claude runs it in the background or with a long timeout; you can keep talking to the session meanwhile.

## How workers run

For each task routed to Claude Code, `orch run` starts a fresh headless session:

```
claude -p --output-format json --no-session-persistence \
  --model <haiku|sonnet|opus|fable> --effort <low|medium|high|xhigh> \
  --permission-mode <...> --allowedTools <...> [--max-budget-usd <n>]
```

| Task mode | Permission mode | May use |
|---|---|---|
| `read` | `dontAsk` | Read, Grep, Glob, web tools, and read-only git and listing commands |
| `write` | `acceptEdits` | the above, plus Edit, Write and Bash |

Write-mode workers are denied `git push`, `git reset --hard`, `git clean`, `git branch -D`, `git checkout .`, `git restore .`, `gh pr create` and `gh pr merge`. They build and commit. Publishing and history rewrites stay with the orchestrator and with you.

Things worth knowing:

- **Each worker starts empty.** It sees its brief, the goal, the worker rules in `skills/orchestrate/worker.md`, and a short excerpt of the reports it depends on. It does not see your conversation.
- **Each worker pays a fixed cost.** A headless session loads about 40,000 tokens of Claude Code's own instructions before it reads the task. On an expensive model that dominates a small task, which is why trivial changes are made directly and not planned.
- **Workers load your user-level setup:** your plugins, MCP servers and `~/.claude/CLAUDE.md`. A project `CLAUDE.md` is read too, since workers run in the project folder.
- **Cost is reported, not guessed.** Claude Code returns the dollar cost of each session, and `orch` shows spent against estimated per task. With a budget set, each worker also gets a hard `--max-budget-usd`.
- **Sessions are not saved.** Workers run with `--no-session-persistence`. Their prompt, log and report are in `.orch/runs/<run>/` in the project.

## Model routing

The router picks a model and effort per task from its kind and size. See what it would choose on your machine:

```
orch detect     which agents are ready
orch models     the catalog: price, quality and speed per model
orch roles      the model each kind of task gets at each size
```

With nothing set, every task goes to the best-quality model for it, which is mostly Fable. To change that:

```
orch setup --profile balanced                  spend less by default
orch setup --role review=claude/opus@high      always review on Opus
orch setup --clear-profile                     back to best quality
```

If Codex is installed and logged in, the router can send tasks to it as well, and prefers it for review of code Claude wrote. Claude Code alone is enough to run everything except the independent verdict, which needs a model that did not write the code: a different Claude model counts.

## Running headless

`/orchestrate` also works without a terminal session, for a script or CI:

```
claude -p "/orchestrate PROJ-123 --approve human" \
  --permission-mode acceptEdits --allowedTools "Read Grep Glob Edit Write Bash"
```

Nobody is there to answer in this mode. When the plan's confidence is too low to start alone, or a decision is yours, the run stops and says what it needs; it does not guess. Set a webhook with `orch setup --webhook <url>` to be told when that happens.

## Telling Claude about orch in a project

Skills load by themselves, so nothing is required. If you want Claude to reach for `orch` without being asked, add a few lines to the project's `CLAUDE.md`:

```markdown
## Tickets

Take Jira tickets through `/orchestrate <KEY>`. It plans, builds in sub-sessions, verifies and opens the PR.
- Standing checks for this repo: `orch.checks.json`. Written standards: `CODING_STANDARDS.md`.
- End-to-end checks: the `verify-<app>` skill under `.claude/skills/`.
- Branches and commits follow Conventional Commits with the ticket key; check with `orch lint`.
```

Keep it to pointers. That file is loaded into every session, so each line costs something whether or not it is used.

## Files it creates

| Where | What |
|---|---|
| `~/.claude/skills/orch*`, `~/.claude/skills/orchestrate` | links to the skills |
| `~/.local/bin/orch` | the launcher |
| `~/.config/orch/config.json` | your settings: profile, roles, approval mode, webhook |
| `~/.config/orch/history.jsonl` | one line per PR gate, to grade the gate against later |
| `<project>/.orch/` | requirements, design, plan, verification report, verdict and run folders. Ignored by git. |
| `<project>/.claude/skills/verify-<app>/` | written by `/orch-verify`. Commit it. |
| `<project>/orch.checks.json` | standing checks, written by you. Commit it. |

## Exit codes

Claude reads these to decide what to do next; they are also what a script should check.

| Command | Code | Meaning |
|---|---|---|
| `orch setup --check` | 1 | setup has not been completed |
| `orch route`, `orch run` | 4 | confidence too low to start alone: raise the listed items to a person |
| `orch run` | 2 | estimate is over budget |
| `orch run` | 1 | a task failed, was skipped, or is waiting on a person |
| `orch run` | 3 | started inside Codex's sandbox (not a Claude Code case) |
| `orch verify` | 1 / 2 | a criterion failed / a person is needed |
| `orch pr gate` | 1 / 2 | gate failed / gate pending |
| `orch verify-skill` | 1 / 2 | no verify skill / stale or unsynced |

## Troubleshooting

- **`/orchestrate` is not offered.** Start a new session. Check `ls -l ~/.claude/skills/orchestrate` points into your clone.
- **`orch: command not found` inside Claude Code.** `~/.local/bin` is not on the `PATH` Claude Code's shell uses. Add it to your shell profile and restart Claude Code.
- **Claude cannot read the ticket.** The Atlassian connector needs signing in: `/mcp`. `orch setup` reports its state as `connected`, `needs-login` or `missing`.
- **A worker ended with "hit its cost cap".** The task was larger than estimated. Raise `--budget`, or split the task.
- **Everything routes to Fable.** That is the default, best quality. Use `--profile balanced` or `orch setup --profile balanced`.
- **`orch verify` refuses to run.** The acceptance criteria changed after the run started. If you agreed to the change, run it with `--relock`.

## What has and has not been run

Run for real in Claude Code: install, setup, planning through routing, sub-sessions on Claude and Codex, per-task checks, fail-first proof, and reading feedback from a public PR.

Not yet run end to end: reading a real Jira ticket through the connector, opening a PR, the review and rework loop, the independent verdict step, and the gate's status, comment and auto-merge calls. Those are covered by unit tests only.
