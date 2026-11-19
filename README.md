# orch

One command, `/orchestrate PROJ-123`, takes a Jira ticket to a reviewed pull request. It works the same in Claude Code and Codex.

Every task goes through six stages, each with its own inputs, outputs and a condition that ends it:

| # | Stage | Produces | Ends when |
|---|---|---|---|
| 1 | **Requirements** | `.orch/requirements.md` | every acceptance criterion can be judged true or false, and you have answered every open decision |
| 2 | **Design** | `.orch/design.md` | every hard-to-reverse decision is settled by you, and the places to test at are named |
| 3 | **Breakdown** | `.orch/plan.json` | every requirement traces to a task and a check, and the plan's confidence is high enough to start |
| 4 | **Development** | commits on a feature branch | every task is done with its own check passing |
| 5 | **Automated testing** | `.orch/verification.md` | the acceptance criteria pass, and a session that did not write the code has run the change |
| 6 | **Review and acceptance** | a PR with its gate published | the gate passes, or you have a decision-ready brief |

Stages 4 to 6 are a loop: a failed check or a review finding goes back as a rework round that fixes only what was named. After three rounds it stops and hands over to you. A trivial change skips the stages and is simply made; a change too large for one PR stops after design and proposes a split.

Skills, in Claude Code (`$name` in Codex):

| Skill | Use |
|---|---|
| `/orchestrate <ticket or task>` | the six stages |
| `/orch-setup` | once per machine: agents, GitHub, Jira connector, alerts, approval mode |
| `/orch-verify` | once per project: a scripted way to start the app and prove a feature |
| `/orch-retro` | after a run: turn what went wrong into a check or a rule |
| `/orch-eval` | is a change to a skill, prompt or model choice really better? A blinded comparison |
| `/orch-me` | draft your own `<name>-mode` skill from how you work |

Inspired by [pstack](https://github.com/cursor/plugins/tree/main/pstack). Where pstack fixes a model per role, orch scores every installed model for every task.

## Install

Needs Node 20+. No dependencies.

```
git clone https://github.com/techgocodingnow/orch.git
cd orch
node src/cli.mjs install
```

Keep the clone: the installed skill and launcher point into it.

This links the six `orch` skills into each agent's skills folder that exists (`~/.claude`, `~/.codex`, `~/.agents`) and writes an `orch` launcher to `~/.local/bin`. It never overwrites a file it did not create. `orch uninstall` removes exactly what it added.

Using Claude Code? [docs/claude-code/README.md](docs/claude-code/README.md) covers install, permissions, how workers run, and troubleshooting.

## Use

In Claude Code (in Codex, type `$orchestrate` instead of `/orchestrate`):

```
/orch-setup
/orchestrate PROJ-123
/orchestrate https://acme.atlassian.net/browse/PROJ-123 --budget 3 --profile quality
/orchestrate --no-pr rename the Store type everywhere
```

The agent you typed that into becomes the orchestrator. It follows [`skills/orchestrate/SKILL.md`](skills/orchestrate/SKILL.md): look at what is installed, write a plan, show you the routing and estimate, run it, then verify the result itself.

The CLI underneath is usable on its own:

```
orch setup                       one-time check of agents, GitHub, Jira connector, alerts
orch detect                      which agent CLIs are ready
orch models                      the catalog routing uses
orch skills "fix a flaky test"   installed skills ranked for a task
orch route plan.json             model and cost estimate per task
orch run plan.json               route, then execute
orch verify plan.json --prove    run the acceptance criteria: pass, fail or needs a human
orch pr gate 42                  publish the verdict on the PR, and auto-merge if you chose that
orch pr feedback 42 --wait 20    unanswered review threads, bot findings, failed checks
orch pr reply <thread> "fixed" --resolve
orch notify "PROJ-123: PR ready" 
```

See [`examples/plan.json`](examples/plan.json) for the plan format.

## Verification

Every PR carries its own definition of done. The plan lists acceptance criteria:

```json
"acceptance": [
  { "id": "limit-429", "criterion": "The 101st request in a minute gets a 429",
    "check": "npm test -- limiter", "proveOn": ["test/limiter.test.js"] },
  { "id": "copy", "criterion": "The error message reads well to a customer",
    "manual": "Read the 429 message in src/limiter.js." }
]
```

### Confidence: start alone, or ask first

Before anything runs, the planner rates its own plan and `orch` turns that into one score:

```
confidence 75/100 (understanding 85, verification 68; needs 70 to start alone)
decision: START without a human
  note: Weak: Criterion "docs": only 60% sure its check proves it: A grep for 429 shows the docs mention it, not that they are right.
  note: Assumed: The limit is per authenticated user, falling back to IP for anonymous requests.
```

- **Understanding** (40%): how sure it is about what the ticket wants. Every guess made in place of asking is listed as an assumption.
- **Verification** (60%): per criterion, how sure it is that a passing check means the criterion holds. The weakest check counts as much as the average.

At or above the bar (70 by default, `minConfidence` in the config or `--min-confidence`), with no single item rated under 50, the run starts by itself and lists its weak spots and assumptions so you can see what it is running on. Otherwise `orch run` refuses, and each weak point is raised as a question: the low-rated criteria, the doubt about the ticket, and every assumption. Anything unrated counts as zero. `--start-anyway` overrides on your say-so.

The ratings are the model's own judgment against a written rubric, so treat the score as a prompt for where to look, not a measurement.

### Running the checks

`orch verify plan.json --prove --repeat 2` runs them and writes a report that goes into the PR body.

- **The kind of check bounds the trust.** Each check is `e2e`, `property`, `differential`, `unit` or `static`. A pass from a test that drives the real app counts for more than one that reads source text, and the planner's own rating is capped by kind (100, 90, 90, 80, 60).
- **A check has to be able to fail.** For each criterion with `proveOn`, `orch` copies only those files onto the code from before the change and runs the check there. If it passes without the change, the criterion fails: the check proves nothing.
- **Three verdicts.** `PASS`: every check passed. `FAIL`: one did not. `NEEDS A HUMAN`: the checks passed and a `manual` criterion is waiting on a person.
- **A change cannot edit its own checks.** The criteria are frozen when the run starts; `orch verify` refuses if they changed, unless you agreed and it is run with `--relock`. If the change rewrites or deletes a test that already existed, a person has to confirm it.
- **Flaky is a failure.** `--repeat 2` runs each passing check again, and pass-then-fail fails. Workers may not skip, sleep or retry their way past one.
- **Three rounds, then a person.** A check that still fails after three fix rounds is raised, not retried.

### A verify skill per project

End-to-end checks need a way to start the app and drive it. `/orch-verify` builds that once per project as a local skill, `verify-<app>`: how to launch, a health check, how to drive each feature, what evidence to capture, one check command per feature, and a feature map that doubles as a grading rubric. The skill is proven before it is handed over: one feature is driven for real, then broken on purpose to confirm its check fails.

The skill records the code it covers and the commit it was last confirmed at. `orch verify-skill`, and every `orch route`, reports whether it is missing, current, or stale because covered files changed since then. `/orch-verify` on a stale skill runs the maintenance pass: reread the changes, drive every feature live, fix the map or the harness, and report product bugs instead of hiding them.

### An independent verdict

An author checks what it meant to build. Before the gate, a fresh session on a model that wrote none of the code runs the change the way a user would, on the old code and the new, and gives one verdict: `PASS`, `PASS+NOTES`, `FAIL` or `INCONCLUSIVE`.

```
orch verdict PASS --by codex/default --notes "export writes the file; old code had no export"
```

`orch` refuses to count a verdict from a model that wrote the code, and voids it if the change is edited afterwards. It is tied to the patch, so a rebase that leaves the change untouched keeps it. `INCONCLUSIVE` holds the gate open; it is never a pass. A verdict is always required before a PR may merge by itself, and `"requireVerdict": true` in the config requires it for every PR.

### Project checks that trigger on the diff

The people who own the code can write standing checks in `orch.checks.json` at the repo root:

```json
[
  { "id": "old-rows", "when": ["src/db/**"], "why": "Rows written before this change still load",
    "ask": "Does every new column have a default? Old rows will not have it." },
  { "id": "api-compat", "when": ["src/api/**"], "why": "The public API stays compatible",
    "check": "npm run test:contract" }
]
```

Only the items whose `when` pattern matches a changed file run. `check` items pass or fail; `ask` items need a person. The file is read from the base branch, never from the change, so a PR cannot weaken the checks that judge it. When review or CI catches something the criteria missed, the agent proposes a new entry and leaves adding it to you.

`orch pr gate <pr>` then publishes one commit status, `orch/verification`, and a comment with the report. It is `success` only when every criterion passed, CI is green, no review item is unanswered, and the verdict was produced on the PR's current commit. You can require that status in branch protection.

Approval is your choice:

```
orch setup --approve human     a person approves; the status tells them it is safe (default)
orch setup --approve observe   same, and it records when it would have merged
orch setup --approve auto      a passing PR gets GitHub auto-merge, pinned to the verified commit
```

Start with `observe`. Every gate is appended to `~/.config/orch/history.jsonl` with its confidence score, verdict and PR, so you can compare what it passed against what was later reverted or rejected before you trust `auto`.

A PR with a `manual` criterion never merges by itself.

## Make it yours

`/orch-me` reads what you typed in recent Claude Code and Codex sessions for this project, finds the habits and corrections that repeat, and drafts a `<your-name>-mode` skill from them. That skill holds your rules and runs tasks through `/orchestrate`, so you keep `orchestrate` as the base and get your own entry point: `/<your-name>-mode PROJ-123`. It reads other projects only if you say so.

Models are yours to set too. `/orch-setup` shows which model each kind of task gets (`orch roles`) and saves only what you change:

```
orch setup --profile cheap                    optional: trade quality for cost
orch setup --clear-profile                    back to best quality
orch setup --role review=claude/opus@high     always review on Opus
orch setup --role review=                     back to the router's choice
```

Everything you did not pin keeps following the router, so new defaults reach you without another setup.

## Bundled skills from pstack

`vendor/pstack/` holds a chosen set of skills and playbooks from [pstack](https://github.com/cursor/plugins/tree/main/pstack), copied unmodified under its MIT license (copyright Lauren Tan). `vendor/pstack/SOURCE.json` records the exact commit and the list; `node scripts/vendor-pstack.mjs` refreshes them.

- **Playbooks** (bug fix, feature, refactoring, investigation, perf, prototype, opening a PR): the planner reads the one that matches the ticket and shapes the plan after it.
- **Skills** (`tdd`, `blast-radius`, `benchmark-checklist`, `architect`, `how`, `why`, `figure-it-out`, `show-me-your-work`, `reflect`, `correct`, `unslop`, `technical-writing`, `typescript-best-practices`, the two formal-verification skills, and the 24 principles): a task can name one as `pstack:<name>` and its worker is told to read and follow it.

They are not installed into your agents, so they add nothing to your slash menu and never replace a skill you already have. If you have your own skill with the same name, a plain name picks yours and `pstack:<name>` picks the bundled one.

Left out on purpose: the skills built on Cursor's subagent fan-out (`arena`, `swarm`, `interrogate`), which `orch run` replaces; `poteto-mode` and its setup, which `/orchestrate` replaces; and the verification-skill generator, which `/orch-verify` adapts. The bundled skills were written for Cursor, so workers are told to translate tool names and to skip Cursor-only steps.

## Branches, commits and PR titles

orch follows [commitlint](https://commitlint.js.org)'s conventional rules, plus the Jira key in each name, so Jira's development panel links the branch, every commit and the PR:

| | format | example |
|---|---|---|
| branch | `<type>/<KEY>-<slug>` | `feat/ACME-412-add-rate-limiting` |
| commit | `<type>(<scope>): <subject>` + `Refs: <KEY>` footer | `feat(api): add rate limiting` … `Refs: ACME-412` |
| PR title | `<type>(<scope>): <subject> (<KEY>)` | `feat(api): add rate limiting (ACME-412)` |

The PR title follows the commit rules because a squash merge makes it the commit on the main branch.

```
orch branch feat ACME-412 add rate limiting     prints feat/ACME-412-add-rate-limiting
orch lint                                       branch name and every commit since the base
orch lint --title "feat(api): add rate limiting (ACME-412)"
```

If the repo has a commitlint config, its rules win: a JSON config (`.commitlintrc`, `.commitlintrc.json`, or `commitlint` in `package.json`) is read directly, and any other config is checked by the repo's own installed commitlint. The key check still comes from orch.

## Jira

Each agent reads tickets through its own Atlassian connector, so there is no token to manage. `orch setup` reports whether the connector is connected in each agent and prints the command to fix it. Without a connector, `orch jira get PROJ-123` reads the ticket over REST if `JIRA_BASE_URL`, `JIRA_EMAIL` and `JIRA_API_TOKEN` are set.

## How routing works

Each task declares a `kind` (mechanical, explore, docs, test, implement, debug, review, design) and a `complexity` (S, M, L). Together they set a quality floor. Every model and effort level at or above the floor is a candidate, scored on quality headroom, estimated cost and speed. A spending level is optional. Set nothing and every task gets the best-quality model for it. A profile trades that for cost or speed:

| profile | picks |
|---|---|
| `cheap` | the cheapest model that clears the floor |
| `balanced` | cheap, nudged toward faster and better |
| `fast` | the quickest model that clears the floor |
| `quality` | raises every floor one point and buys headroom (used when you set nothing) |

A `review` task leans toward a different vendor than the tasks it reviews.

## Cost control

- `--budget <usd>` caps the plan. The router downgrades whichever task loses the least quality per dollar saved until the estimate fits. It will not go below a floor: if the plan still does not fit it says `OVER BUDGET` and refuses to run. `--relax` allows dropping up to 1.5 points below floors, and names each task it weakened.
- At run time the budget is enforced on real spend. Claude tasks get a hard `--max-budget-usd`. Once the budget is spent, remaining tasks are skipped.
- Per task, a plan can pin `"model": "claude/opus@high"`, `"agent": "codex"`, or `"maxCost": 0.5`.
- A failed task is retried once on the next stronger model.

Estimates are rough: a size bucket times list price, plus about 60k tokens of fixed overhead per call for the agent's own system prompt. Real cost is reported per task after the run. Claude Code reports dollars itself. Codex cost is computed from its token counts.

## Configure

`~/.config/orch/config.json`, overridden per project by `.orch/config.json`:

```json
{
  "profile": "cheap",
  "budget": 5,
  "concurrency": 4,
  "models": [
    { "id": "codex/default", "in": 0, "out": 0 },
    { "id": "codex/terra", "agent": "codex", "model": "gpt-5.6-terra", "in": 3, "out": 15, "quality": 9, "speed": 5, "efforts": ["low", "medium", "high"] }
  ]
}
```

A `models` entry with a known id patches that model. A new id adds one. The `quality` and `speed` scores are 1-10 opinions that drive routing, so tune them to your experience. Prices marked `~` in `orch models` are placeholders.

## Safety

Read tasks run with read-only tools (Claude) or a read-only sandbox (Codex). Write tasks may edit files and run shell commands in the project: Claude with `acceptEdits`, Codex with the `workspace-write` sandbox. Write tasks take turns in the shared checkout. A task with `"isolation": "worktree"` gets its own branch so several can write at once.

Everything a run produces lives in `.orch/runs/<id>/`: the routed plan, each prompt, raw log and report.

## Status

| host you type into | workers | state |
|---|---|---|
| Claude Code | Claude Code and Codex | planning, routing, sub-sessions and checks run end to end. The ticket-to-PR path (reading Jira through the connector, opening the PR, the review-fix loop) has not yet been run against a real ticket. |
| Codex | Claude Code and Codex | needs one approval: Codex must run `orch run` outside its sandbox, because workers need network access. `orch` exits with code 3 and says so when it is sandboxed. |

Cursor is not supported yet. An adapter exists, written from `cursor-agent --help` and never run. To try it, set `"agents": { "cursor": { "enabled": true } }` in the config.

```
npm test
```

## License

MIT
