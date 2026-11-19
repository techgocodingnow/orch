# Automated review

Three read-only reviewers, each in its own fresh sub-session, each answering one question. They are kept separate because a change can pass one and fail another, and a single blended review lets the passing part hide the failing one.

## The tasks

Append these to `tasks` in `.orch/plan.json`, replacing `<base>` with the branch the PR will merge into, then run them with `--only`.

```json
{ "id": "review-spec", "title": "Review against the requirements", "kind": "review", "complexity": "M", "mode": "read",
  "prompt": "<spec brief below>" },
{ "id": "review-standards", "title": "Review against the repo's standards", "kind": "review", "complexity": "S", "mode": "read",
  "prompt": "<standards brief below>" },
{ "id": "review-break", "title": "Try to break the change", "kind": "review", "complexity": "M", "mode": "read",
  "prompt": "<break-it brief below>" }
```

## Spec brief

> Review the diff `git diff <base>...HEAD` against `.orch/requirements.md`. Report three things: (a) requirements that are missing or only partly implemented; (b) behaviour in the diff that no requirement asked for; (c) requirements that look implemented but where the implementation is wrong. Quote the requirement line for every finding and name the file and lines in the diff. Under 400 words. No findings is a valid result.

## Standards brief

Before writing this brief, find the files that say how code in this repo should be written: `CODING_STANDARDS.md`, `CONTRIBUTING.md`, `REVIEW.md`, the agent instruction file. Read them from the base branch (`git show <base>:<path>`), so the change under review cannot have edited the rules it is judged by. List them in the brief.

> Review the diff `git diff <base>...HEAD` against these standards files: <list>. Report (a) every place the diff breaks a written rule: cite the file and the rule; and (b) any of these smells you see, named and with the hunk quoted: a name that does not say what the thing does, the same logic in two places, a method that uses another object's data more than its own, fields that always travel together, a primitive standing in for a domain concept, abstraction added for needs the requirements do not have. A written rule can be a hard finding. A smell is always a judgement call, and a written rule overrides it. Skip anything a linter or formatter already enforces. Under 400 words. No findings is a valid result.

## Break-it brief

> Break this change. The diff is `git diff <base>...HEAD` and what it must do is in `.orch/requirements.md`. Prove each finding with a run against the real code: a failing test, a repro script, or command output that shows the wrong behaviour. Keep anything you write in a scratch directory outside the repo. Report each finding with a title, the exact command, the output it printed, and the output the requirements call for. Leave out anything you did not run, which covers style, naming, and risks that need a future change to matter. No findings is a valid result.

## Judging what comes back

A reviewer's report is a set of leads, not a set of facts. For each finding:

| from | keep it when |
|---|---|
| spec | The quoted requirement really is unmet, exceeded or wrongly met in the diff. |
| standards | It cites a written rule the diff breaks. For a smell, the fix is clearly better and stays inside this ticket's scope. |
| break-it | You reran the command and the output shows a failure that breaks a requirement. |

Drop the rest, and say how many you dropped and why, so the user can see the review was read and not rubber-stamped in either direction.

Findings about security, auth, billing, data loss or migrations are never dropped on your judgement alone. Fix them or raise them to the user.

## The rework brief

```json
{ "id": "rework-1", "title": "Fix review findings, round 1", "kind": "implement", "complexity": "S", "mode": "write",
  "prompt": "Fix exactly these findings and nothing else. For each, the finding, where it is, and what correct looks like:\n1. ...\n2. ...\nDo not refactor, rename or improve anything not listed. Run the project's checks before you finish." }
```

Then `orch run .orch/plan.json --only rework-1`, return to stage 5, and confirm each fix on its own: rerun the finding's command or reread the lines it named. Number later rounds `rework-2` and `rework-3`. There is no `rework-4`.
