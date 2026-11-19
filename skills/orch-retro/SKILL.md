---
name: orch-retro
description: Look back over an /orchestrate run and propose changes to the project's checks and standards so the same mistake cannot recur. Use when the user types /orch-retro, after a run where review or CI caught something the acceptance criteria missed, when a worker repeated a mistake, when a rework round was needed, or when the user asks what would have prevented a problem.
---

# Orch retro

A run that went wrong once is information. This skill turns it into a change to the environment the next run starts from: a check that fails, a rule a reviewer reads, a pointer that saves a search. It proposes; the user decides. Nothing is written until they pick.

## 1. Read what happened

Read the primary sources, not your memory of them:

- `.orch/runs/<run>/`: `state.json` for which tasks failed, were retried on a stronger model, or needed fix rounds; each task's `.result.md` and `.log`.
- `.orch/verification.md` and the PR's review threads (`orch pr feedback <pr>`).
- `.orch/requirements.md` and `.orch/plan.json`, to compare what was planned with what happened.
- `~/.config/orch/history.jsonl`, for how earlier gates on this repo turned out.

Default to the most recent run unless the user names one.

## 2. Find the moments

Look for specific moments where something cost time or let a defect through:

- A reviewer, CI or the user caught a bug the acceptance criteria passed.
- A check passed that should not have, or failed for the wrong reason.
- A worker made the same mistake another worker made, or one a previous run made.
- A rework round was needed. What made the first attempt wrong?
- A worker spent a long time finding something a pointer would have told it.
- A question was raised to the user that the repo could have answered.
- The plan's confidence score was high and the run went badly, or the reverse.

Keep a candidate only if you can point to the moment it comes from: the task, the log line, the review thread. Advice that could apply to any project is noise; leave it out.

## 3. Choose where each fix belongs

A fix belongs at the highest level that can enforce it. A check can fail; a sentence in a document cannot.

| the mistake was | the fix is | where |
|---|---|---|
| mechanical: a banned call, a wrong import, a file in the wrong place, a format | a deterministic check | the project's linter, a test, a pre-commit hook or CI job. If a check already exists but is not wired into CI, wiring it is the fix. |
| a class of change that needs a specific question asked or command run | a standing check with a trigger | an entry in `orch.checks.json`, with the file pattern that should trigger it |
| a judgement call a reviewer should make | a written standard | `CODING_STANDARDS.md` or `REVIEW.md`, which the standards reviewer reads |
| a fact that was hard to find | a pointer | one line in the agent instruction file naming where to look |
| a criterion that was too weak | a note for next time | nothing to write: say what a stronger check would have been |

Prefer the check over the rule every time the mistake can be checked. Keep the agent instruction file for pointers: it is loaded in every session, so each line there costs something whether or not it helps.

A project with no lint, type-check or test command running before merge is itself a finding, and usually the most valuable one.

## 4. Propose

Present the candidates, most severe first. For each:

```markdown
**<what went wrong>**: <where it happened: task, thread or log line>
**Fix:** <the check, entry, rule or pointer, written out exactly>
**Where:** <file>
**How to know it works:** <the command that fails today on the mistake and passes once fixed>
```

For an `orch.checks.json` entry, write the entry in full:

```json
{ "id": "old-rows", "when": ["src/db/**"], "why": "Rows written before this change still load",
  "ask": "Does every new column have a default? Old rows will not have it." }
```

Use `check` with a command when a command can judge it, and `ask` when a person must.

Then stop and let the user choose. Proposing three good changes is better than ten: every check and rule added is something to maintain.

## 5. Apply what they picked

For each accepted fix:

1. Make the change in a branch of its own, separate from any feature work.
2. Show that it bites: run it against the mistake it is for and see it fail, then against the corrected code and see it pass. A check that has never failed has not been tested.
3. Try a new check against the current codebase before it is allowed to block anything. One that fires on good code will be switched off within a week, and takes trust in the others with it.
4. Open a PR for the user to review. Changes to the checks themselves always get a person's review, because they decide what every later change is judged by.

## 6. Prune

While you are in these files, look for what has stopped earning its place: an `orch.checks.json` entry whose pattern no longer matches any file, a rule a linter now enforces, a standard nobody has cited. Propose removing them. These files only grow unless someone tidies them, and a long list that is mostly stale gets ignored whole.

Report what you proposed, what was accepted, and what you left alone and why.
