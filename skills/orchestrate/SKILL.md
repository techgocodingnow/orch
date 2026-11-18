---
name: orchestrate
description: Split a task into parts, pick the best installed skill and the cheapest capable model for each part, and run them across the installed coding agents (Claude Code, Codex, Cursor) within an optional dollar budget. Use when the user types /orchestrate or asks to orchestrate a task across agents or models.
---

# Orchestrate

You are the orchestrator. You plan, the `orch` CLI routes and runs, and you verify and report. The CLI behaves the same in every agent, so follow these steps whichever agent you are.

Usage: `/orchestrate [--budget <usd>] [--profile cheap|balanced|fast|quality] [--agents a,b] <task>`

If `orch` is not on PATH, tell the user to run `node <repo>/src/cli.mjs install` and stop.

## 1. Read the request

Pull out the task and any flags. No profile means `balanced`. No budget means no cap. Restate the goal in one sentence.

A task that is one small step needs no orchestration. Do it yourself and say so.

## 2. Look at what is available

Run both, in parallel:

```
orch detect
orch skills "<the task in the user's words>" --top 8
```

`orch skills` ranks by keyword only. Read the descriptions and decide for yourself which skills fit which part of the work. Most tasks need zero or one skill. Never attach a skill because it scored well.

## 3. Write the plan

Explore the code only as much as you need to split the work well. Then write `.orch/plan.json`:

```json
{
  "goal": "one sentence, the outcome the user wants",
  "tasks": [
    {
      "id": "find-callers",
      "title": "Find every caller of the sync store",
      "kind": "explore",
      "complexity": "S",
      "mode": "read",
      "prompt": "Self-contained brief. The worker sees only this, the goal, and the reports of its deps.",
      "deps": []
    }
  ]
}
```

Fields per task:

| field | values |
|---|---|
| `kind` | `mechanical` `explore` `docs` `test` `implement` `debug` `review` `design`. Sets the quality the model must reach. |
| `complexity` | `S` a few files and minutes, `M` a real unit of work, `L` wide or subtle. Sets the cost estimate and nudges quality. |
| `mode` | `read` or `write`. Read tasks run in parallel. Write tasks take turns unless isolated. |
| `deps` | ids whose reports this task needs. They are pasted into its prompt. |
| `skill` | optional, the name of one installed skill from step 2. The worker is told to read and follow it. |
| `isolation` | optional `"worktree"`. The task gets its own git worktree and branch so write tasks can run in parallel. You merge the branches afterward. |
| `model`, `agent`, `maxCost` | optional pins. Set them only when the user asked: `"model": "claude/opus@high"`, `"agent": "codex"`, `"maxCost": 0.5`. |

How to split:

- One task per unit that ends in something checkable. Three to seven tasks is typical. More tasks cost more.
- Be honest about `kind` and `complexity`. Inflating them wastes money and deflating them buys bad work.
- Parallel write tasks must touch different files. If you cannot guarantee that, chain them with `deps` or isolate them.
- End a code change with a `review` task that depends on the write tasks. The router prefers a different vendor for it than the author.
- Write each prompt for a reader with no context: the goal, the files, the constraints, how to check the result.

## 4. Route and show the user

```
orch route .orch/plan.json [--profile <p>] [--budget <usd>] [--agents a,b]
```

Show the table: task, model, estimated cost, total. Then:

- Estimate within budget, or no budget set: go on to step 5 without asking.
- `OVER BUDGET`: do not run. Give the user the options with numbers: drop or shrink tasks, pass `--relax` (some tasks fall below their quality floor), or raise the budget. Wait for their choice.

Estimates are rough. Prices marked `~` are placeholders.

## 5. Run

```
orch run .orch/plan.json [same flags]
```

This blocks until every task finishes, so give it a long timeout or run it in the background. It prints one line as each task starts and ends, then a table with the real cost. Reports land in `.orch/runs/<run>/<task>.result.md`, raw logs beside them.

A failed task is retried once on a stronger model. Tasks downstream of a failure are skipped. When the budget runs out, the remaining tasks are skipped.

## 6. Verify and report

You own the result. Workers' reports are claims, not proof.

- Read each report. For write tasks, read the diff yourself and run the project's tests.
- Merge any `orch/<run>/<task>` worktree branches, resolving conflicts.
- Fix small gaps yourself. For a large gap, write a follow-up plan with only the missing tasks and run it.

Tell the user: what was done, the evidence it works, what failed or was skipped, and spent versus estimated cost per task.
