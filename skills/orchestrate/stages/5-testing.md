# Stage 5: Automated testing

**In:** a committed feature branch. **Out:** `.orch/verification.md`. **Ends when** `orch verify` gives a verdict other than FAIL on a clean commit.

Stage 4 checked each task on its own. This stage checks the whole change against the definition of done, and is what decides whether the PR passed.

## 1. Run the cheap checks first

Run the project's own lint, type-check, static analysis and full test suite, the same commands CI will run. Fix what they find before going further: a failure here caught locally costs seconds, and the same failure caught in CI costs a review round and everyone's attention.

Where the project has them, also run its integration, contract and security checks, and any threshold it enforces (coverage, bundle size, performance budget). Use the project's real commands; do not invent thresholds it does not have.

## 2. Run the acceptance criteria

Commit first, then:

```
orch verify .orch/plan.json --prove --repeat 2
```

It runs every criterion's check and writes the report to `.orch/verification.md`. Beyond your own criteria it applies three things:

- **Fail-first proof.** For each criterion with `proveOn`, it runs the check against the code from before the change and requires it to fail there.
- **Project checks.** Every entry in the repo's `orch.checks.json` whose pattern matches a changed file runs too. They are read from the base branch, so the change cannot alter them.
- **Stability.** Each passing check runs twice. Passing then failing counts as failing: a check that flickers tells you nothing either way.

It also flags, for a person to confirm, any test that existed before and was edited or removed by this change.

## 3. Act on the verdict

| verdict | meaning | next |
|---|---|---|
| **PASS** | every check passed | stage 6 |
| **NEEDS A HUMAN** | the checks passed; a `manual` criterion, a project `ask` item or an edited test needs a person | stage 6; it will hold at the gate for them |
| **FAIL** | a check failed, could not fail before the change, or was flaky | fix it, below |

On FAIL, find the cause in the code and fix the code. Start from what the report shows, not from scratch. A flaky check is a bug to find, in the test or in the product: retrying, sleeping or skipping only hides it.

The criteria were frozen when `orch run` started, and `orch verify` refuses to run if they have changed. That is deliberate: a change that can rewrite the check that judges it has not been checked. If a criterion really is wrong, tell the user why, and only with their agreement change it and pass `--relock`.

Before you blame the code for a surprising result, check the check: did it run the work you think it ran? A test that was skipped, a server that never started, or a cached result all look like a pass or a fail without being one. Confirm the command exercised the change (it printed the count of tests it ran, it hit the real route) before trusting what it says.

## 4. Get an independent verdict

Everything so far was produced by sessions that wrote the code or by checks they wrote. An author checks what it meant to build. So one fresh session that wrote none of it runs the change the way a user would and says what it saw. Green CI and an approving bot do not replace this, because neither uses the thing.

Append a verifier task and run only it. Pin it to an agent that authored none of the write tasks (`orch run` printed each task's model):

```json
{ "id": "verify-live", "title": "Run the change as a user would", "kind": "review", "complexity": "S", "mode": "write", "agent": "<the other vendor>",
  "prompt": "You did not write this change. Do not edit any file in the repository; work in a scratch directory if you need files.\n\nWhat it must do is in .orch/requirements.md. For each acceptance criterion: (1) on the base commit <base>, in a separate worktree, do what a user would do and record what happens; do it twice; (2) on this branch, do the same thing twice and record what happens. Use the project's verify-<app> skill if it has one.\n\nReport per criterion: the exact commands, the output before, the output after. Then one overall verdict: PASS (every criterion shows the wanted behaviour after, and for a fix the fault before), PASS+NOTES (passes, with something the user should know), FAIL (name the criterion and the output), or INCONCLUSIVE (say which half you could not observe and why). A baseline you could not reproduce twice is INCONCLUSIVE, not a pass." }
```

```
orch run .orch/plan.json --only verify-live
orch verdict <PASS|PASS+NOTES|FAIL|INCONCLUSIVE> --by <agent/model> --notes "<one line>"
```

Record the verdict the verifier gave, not the one you hoped for. `orch` refuses to count a verdict from a model that wrote the code, and voids it if the change is edited afterwards (it survives a rebase that leaves the change itself untouched). `INCONCLUSIVE` holds the gate open rather than passing it: say what blocked it and fix that, or hand it to the user. `FAIL` is a rework round.

The verdict is required before anything can merge by itself. On a trivial or low-risk standard ticket with `--approve human` you may skip it and say so in the brief; a person is about to look anyway.

This fix-and-verify cycle is a rework round and counts toward the limit of three in the loop. After three, stop and hand the failing checks and their output to the user.
