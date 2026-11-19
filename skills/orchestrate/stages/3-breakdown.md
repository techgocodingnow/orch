# Stage 3: Breakdown

**In:** `.orch/requirements.md`, `.orch/design.md`. **Out:** `.orch/plan.json`. **Ends when** every requirement traces to a task and a check, and `orch route` says START.

This is the work breakdown: requirements become tasks, each with a brief, its dependencies, and the check that says it is done. Read `references/plan-format.md` now for the file's fields, the check kinds and the confidence rubric.

## 1. See what you can use

Run `orch detect`, `orch skills "<the task>" --top 8` and `orch verify-skill`.

- The skill ranking is by keyword only. Attach a skill to a task when its description clearly fits, and at most one per task. `pstack:` skills ship with `orch`; `references/plan-format.md` lists when each helps.
- If the project has a current `verify-<app>` skill, read its feature map: it tells you how to check behaviour end to end. If it is `missing` or `stale` and the ticket changes what a user sees, tell the user and recommend `/orch-verify` first. It is a one-time cost per project.

## 2. Write the acceptance criteria as checks

Take each criterion from the requirements and give it a check at the seam the design named. This is the definition of done for the whole PR, and it is frozen once work starts, so get it right here.

Give every criterion about new or fixed behaviour a `proveOn`, so `orch` can confirm the check fails on the code before the change. A check that has never been seen to fail proves nothing. Rate each one honestly against the rubric: a low rating costs the user one question now, and a high rating that is wrong costs a bad PR that passed.

Where no command can judge a criterion (wording, look and feel), make it `manual` and say exactly what a person should look at.

## 3. Slice the work vertically

Split the work into tasks that each deliver one thin, complete piece of behaviour through every layer it needs, checkable on its own. A slice that adds the schema, the endpoint and its test for one case is a good task. "All the tests", then "all the code", is not: tests written in bulk describe imagined behaviour and stop being sensitive to the real thing.

- Each slice is small enough for one fresh sub-session and ends in a check that passes. A worker starts with an empty context and has to read everything it needs, so a slice that touches more than about ten files, or needs the whole subsystem understood first, is two slices. When the reading itself is the bulk of the work, make it a separate `explore` task whose report the build task depends on.
- Put any preparatory refactor first, as its own task: make the change easy, then make the easy change.
- Give each task `deps`: the tasks that must finish before it can start. Tasks with no unmet deps run in parallel.
- A wide mechanical change that touches everything (renaming a shared type) cannot be a vertical slice. Sequence it as expand, migrate in batches, contract.
- For a bug, the first task turns the reproduction from stage 1 into a failing test, and the fix depends on it.

Three to seven tasks suits most tickets. Fewer, larger tasks lose the checkpoints; many tiny ones cost a session's overhead each.

## 4. Write each brief as a contract

A worker sees only its brief, the goal, and the reports of its deps. Write the `prompt` so that a capable engineer who has never seen this repo could do the task:

- **What to build**, as behaviour and interfaces. Name the types, functions and routes involved. File paths are welcome as pointers, but describe the behaviour so the brief still holds if a file has moved.
- **Acceptance:** how the worker will know it is done.
- **Out of scope:** the adjacent things to leave alone.
- **Decisions already made** in stages 1 and 2 that bear on it, so the worker does not re-decide them.

## 5. Mark what needs a person

A task that is a person's to do (provide a credential, make a production change, approve a migration) gets `needsHuman` with one sentence saying what is needed. Tasks that depend on it list it in `deps` and wait; everything else runs.

## 6. Trace, rate, route

Check the trace both ways: every acceptance criterion has a check and at least one task that makes it pass, and every task serves a criterion. A task that serves none is scope creep; a criterion with no task will not get built.

Fill in `confidence.understanding` and list your assumptions. Then:

```
orch route .orch/plan.json [--profile <p>] [--budget <usd>]
```

Show the user the routing table, the criteria with their confidence and reasons, and the confidence block.

- **START:** go to stage 4. Tell the user the score, the `Weak:` items and the assumptions you are running on, so they can stop you.
- **RAISE** (exit code 4): put each `raise:` line to the user as a question with your recommended answer, send `orch notify "<KEY>: needs your input before starting"`, and wait. When they answer, improve the plan and route again. Raising your own ratings to get through defeats the purpose of having them.
- **OVER BUDGET:** give the user the options with numbers (drop or shrink tasks, a cheaper profile, a larger budget) and wait.
