# The plan file

`.orch/plan.json` is what `orch` routes, runs and verifies. This is its full format.

## Contents

- [Example](#example)
- [Top-level fields](#top-level-fields)
- [Acceptance criteria](#acceptance-criteria)
- [Check kinds](#check-kinds)
- [Confidence rubric](#confidence-rubric)
- [Tasks](#tasks)
- [Bundled skills and playbooks](#bundled-skills-and-playbooks)

## Example

```json
{
  "goal": "Signed-in users are limited to 100 API requests a minute.",
  "source": { "type": "jira", "key": "PROJ-123", "url": "https://acme.atlassian.net/browse/PROJ-123" },
  "confidence": {
    "understanding": 85,
    "why": "The ticket gives the limit and the response. The user confirmed it is per user.",
    "assumptions": ["Anonymous requests are limited per IP address."]
  },
  "verify": "npm test",
  "acceptance": [
    { "id": "limit-429", "criterion": "The 101st request in a minute gets a 429 with Retry-After",
      "check": "npm run e2e -- limiter", "kind": "e2e", "proveOn": ["e2e/limiter.spec.js"],
      "confidence": 90, "why": "Sends 101 real requests through the HTTP handler." },
    { "id": "docs", "criterion": "The API docs state the limit",
      "check": "grep -q '100 requests' docs/api.md", "kind": "static",
      "confidence": 60, "why": "Shows the docs mention it, not that they are right." },
    { "id": "copy", "criterion": "The 429 message reads well to a customer",
      "manual": "Read the message returned by the limiter." }
  ],
  "tasks": [
    { "id": "limiter-core", "title": "Limit one user to 100 requests a minute",
      "kind": "implement", "complexity": "M", "mode": "write", "deps": [],
      "verify": "npm run e2e -- limiter",
      "prompt": "What to build, acceptance, out of scope, decisions already made." },
    { "id": "prod-limits", "title": "Confirm the production limit",
      "needsHuman": "Product has to confirm 100 a minute before this ships." }
  ]
}
```

## Top-level fields

| field | meaning |
|---|---|
| `goal` | One sentence: the outcome. Every worker sees it. |
| `source` | Where the task came from. Optional. |
| `confidence` | Your own rating of the plan. See the rubric. |
| `verify` | A shell command that must exit 0 for any write task that has no `verify` of its own. Use the project's real test command. |
| `acceptance` | The definition of done for the PR. Required. Frozen when `orch run` starts. |
| `tasks` | The work. |

## Acceptance criteria

Each entry is one criterion with either a check or a named thing for a person to look at.

| field | meaning |
|---|---|
| `id` | Short, unique, letters, digits, dashes. |
| `criterion` | One sentence a reviewer can judge true or false. |
| `check` | A shell command that exits 0 only when the criterion holds. |
| `kind` | What sort of check it is. See below. |
| `proveOn` | The files that hold the check, usually the new test files. `orch verify --prove` copies only these onto the code from before the change and requires the check to fail there. Give it for every criterion about new or fixed behaviour. When the check is a plain command that needs no new files, such as a one-line reproduction of a bug, use `[]`: the command is then run as it is against the old code. |
| `confidence`, `why` | How sure you are that a pass means the criterion holds, and the reason. |
| `manual` | Use instead of `check` when no command can judge it. Say exactly what the person should look at. A plan with a manual criterion never passes without a person. |

## Check kinds

The kind caps how far a pass is trusted, whatever rating you give it. A check that drives the real system is hard to satisfy with the feature broken; one that reads text is easy.

| kind | what it does | cap |
|---|---|---|
| `e2e` | Runs the real app and drives the feature the way a user would: the request, the command, the page. The first choice for any new or fixed behaviour. | 100 |
| `property` | States something that must always hold and lets a library generate inputs to break it (fast-check, Hypothesis, proptest). For parsers, serializers, invariants, retries, idempotent operations. | 90 |
| `differential` | Runs old and new code on the same inputs and compares. For refactors and migrations, where the old behaviour is the answer key. | 90 |
| `unit` | Calls a function directly. Fast, but it can pass while the feature is broken, because the test knows no more about the task than the code does. | 80 |
| `static` | Reads source, config or docs. | 60 |

Match the check to the change:

| the change | a check that fits |
|---|---|
| a CLI command | run the real command and assert on its output and exit code |
| a UI flow | walk the changed flow in the running app; for pixel-level work, diff screenshots against a saved baseline |
| a parser, serializer or migration | replay a saved real input |
| a performance change | compare measured before and after, several alternating runs, median and range |
| a storage change | write, then read the value back through a second, read-only path |
| an API | call the endpoint and assert on status, body and side effects |

Judge every check against two imagined edits. Break the behaviour (a wrong value, a skipped effect): the check must fail, or it proves nothing. Change the internals and keep every observable result: the check must still pass, or it is pinned to the implementation and will cry wolf on the next refactor. Keep checks that catch the first and survive the second.

Whatever the kind, the expected value in a test must come from somewhere independent of the code: a literal, a worked example, the spec. A test that recomputes its expectation the way the code does passes by construction.

## Confidence rubric

`orch route` combines these into one score: understanding 40%, verification 60%, where the weakest check counts as much as the average. At or above the bar (70 by default) with nothing under 50, the run starts alone. Otherwise each weak point is raised to the user.

`confidence.understanding`: how sure you are that you know what is wanted.

| score | means |
|---|---|
| 90+ | The ticket states the behaviour and how to accept it, the user confirmed the open decisions, and the code agrees. |
| 70-89 | Small gaps, filled with assumptions that are cheap to reverse. |
| 50-69 | One assumption that changes the design if it is wrong. |
| below 50 | You are guessing what is wanted. |

List every guess made in place of asking under `assumptions`.

A criterion's `confidence`: how sure you are that a passing check means the criterion really holds.

| score | means |
|---|---|
| 90+ | Drives the real behaviour end to end, and `proveOn` will show it failing before the change. |
| 70-89 | Exercises the real code through a narrower seam. |
| 50-69 | Indirect: inspects output text, source or config. |
| below 50 | Would still pass with the feature broken in a plausible way. |

If a better check would raise a low score, write the better check. If none can, make the criterion `manual`.

## Tasks

| field | meaning |
|---|---|
| `id`, `title` | Short id; a title a person can read in a table. |
| `kind` | `mechanical` `explore` `docs` `test` `implement` `debug` `review` `design`. Sets the quality the model must reach. |
| `complexity` | `S` a few files and minutes, `M` a real unit of work, `L` wide or subtle. Sets the cost estimate and nudges quality. Rate it as it is: inflating wastes money, deflating buys weak work. |
| `mode` | `read` or `write`. Read tasks run in parallel; write tasks take turns unless isolated. |
| `deps` | Ids that must finish first. Their reports are pasted into this task's prompt. |
| `prompt` | The brief: what to build, acceptance, out of scope, decisions already made. |
| `verify` | A shell command that must exit 0 before this task counts as done. Overrides the plan's `verify`. |
| `needsHuman` | One sentence saying what a person must do or decide. Such a task needs only `id` and `title`. |
| `skill` | One installed skill for the worker to read and follow. |
| `isolation` | `"worktree"` gives the task its own branch so write tasks can run in parallel. You merge afterwards. Tests that depend on untracked files (local fixtures, credentials) may be skipped silently in a worktree, so the final `orch verify` always runs in the main checkout. |
| `model`, `agent`, `maxCost` | Pins. Set them only when the user asked: `"claude/opus@high"`, `"codex"`, `0.5`. |

## Bundled skills and playbooks

`orch` ships a chosen set from pstack. `orch skills` lists them as `pstack:<name>` and prints each one's path; the playbooks sit in the `playbooks` folder beside that `skills` folder. They were written for one agent in Cursor, so where one says to spawn or delegate, make that a task in the plan.

Read the playbook that matches the ticket before slicing:

| ticket | playbook | what it changes in the plan |
|---|---|---|
| bug | `bug-fix.md` | Reproduce before any fix. Check the fix on the surface the bug was seen on. Commit the failing repro before the fix. |
| new or changed behaviour | `feature.md` | Trace the subsystem and settle the shape first. Name the data shape in each brief. |
| restructuring | `refactoring.md` | Pin current behaviour with a characterization test first; every later step keeps it passing. Use a `differential` criterion. |
| a question, no code | `investigation.md` | Read-only tasks, a cited answer, no PR. |
| slowness | `perf-issue.md` | Measure a baseline first. |

Skills worth attaching to a task:

| when the task | skill |
|---|---|
| fixes a bug test-first | `pstack:tdd` |
| is a small change whose safety rests on something outside the diff | `pstack:blast-radius` |
| reports a measured speedup or regression | `pstack:benchmark-checklist` |
| designs code that crosses a module boundary | `pstack:architect` |
| writes docs, a PR body or commit messages | `pstack:technical-writing` |
| guards a race, retry, state machine or parser that tests cannot reach | `pstack:create-formal-verification-skill` |
