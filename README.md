# orch

One command, `/orchestrate`, that works the same in Claude Code, Codex and Cursor. It splits a task into parts, attaches the installed skill that fits each part, picks the cheapest model that is good enough for it, and runs the parts across whichever agent CLIs you have, inside an optional dollar budget.

Inspired by [pstack](https://github.com/cursor/plugins/tree/main/pstack). Where pstack fixes a model per role, orch scores every installed model for every task.

## Install

Needs Node 20+. No dependencies.

```
git clone https://github.com/techgocodingnow/orch.git
cd orch
node src/cli.mjs install
```

Keep the clone: the installed skill and launcher point into it.

This links `skills/orchestrate` into each agent's skills folder that exists (`~/.claude`, `~/.codex`, `~/.cursor`, `~/.agents`) and writes an `orch` launcher to `~/.local/bin`. It never overwrites a file it did not create. `orch uninstall` removes exactly what it added.

## Use

In any agent:

```
/orchestrate add rate limiting to the public API and prove it works
/orchestrate --profile cheap rename the Store type everywhere
/orchestrate --budget 3 --profile quality find and fix the scroll drift bug
```

The agent you typed that into becomes the orchestrator. It follows [`skills/orchestrate/SKILL.md`](skills/orchestrate/SKILL.md): look at what is installed, write a plan, show you the routing and estimate, run it, then verify the result itself.

The CLI underneath is usable on its own:

```
orch detect                      which agent CLIs are ready
orch models                      the catalog routing uses
orch skills "fix a flaky test"   installed skills ranked for a task
orch route plan.json             model and cost estimate per task
orch run plan.json               route, then execute
```

See [`examples/plan.json`](examples/plan.json) for the plan format.

## How routing works

Each task declares a `kind` (mechanical, explore, docs, test, implement, debug, review, design) and a `complexity` (S, M, L). Together they set a quality floor. Every model and effort level at or above the floor is a candidate, scored on quality headroom, estimated cost and speed. The profile sets the weights:

| profile | picks |
|---|---|
| `cheap` | the cheapest model that clears the floor |
| `balanced` | cheap, nudged toward faster and better (default) |
| `fast` | the quickest model that clears the floor |
| `quality` | raises every floor one point and buys headroom |

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
  "profile": "balanced",
  "budget": 5,
  "concurrency": 4,
  "agents": { "cursor": { "enabled": false } },
  "models": [
    { "id": "codex/default", "in": 0, "out": 0 },
    { "id": "codex/terra", "agent": "codex", "model": "gpt-5.6-terra", "in": 3, "out": 15, "quality": 9, "speed": 5, "efforts": ["low", "medium", "high"] }
  ]
}
```

A `models` entry with a known id patches that model. A new id adds one. The `quality` and `speed` scores are 1-10 opinions that drive routing, so tune them to your experience. Prices marked `~` in `orch models` are placeholders.

## Safety

Read tasks run with read-only tools (Claude) or a read-only sandbox (Codex). Write tasks may edit files and run shell commands in the project: Claude with `acceptEdits`, Codex with the `workspace-write` sandbox, Cursor with `--force`. Write tasks take turns in the shared checkout. A task with `"isolation": "worktree"` gets its own branch so several can write at once.

Everything a run produces lives in `.orch/runs/<id>/`: the routed plan, each prompt, raw log and report.

## Status

Run end to end against Claude Code and Codex. The Cursor adapter is written from `cursor-agent --help` and has not been run.

```
npm test
```

## License

MIT
