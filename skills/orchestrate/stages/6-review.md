# Stage 6: Review and acceptance

**In:** a branch whose verification is not FAIL. **Out:** a PR with its gate published. **Ends when** the gate is `success`, or a person has been handed a decision-ready brief.

Three brakes stand between a change and the main branch: automated checks (stage 5), automated review by sessions that did not write the code, and a person. This stage runs the second and prepares the third.

With `--no-pr`, do step 1 and step 2, then skip to step 7.

## 1. Automated review

Commit everything first: reviewers read the diff between the base and the branch's last commit, and cannot see uncommitted work.

Review needs fresh eyes: the session that wrote the code checks what it meant to build, not what it built. Add three read-only review tasks to `.orch/plan.json` and run only those. `references/review.md` has the brief for each and the task entries to copy.

| reviewer | question it answers |
|---|---|
| **spec** | Does the diff do what `.orch/requirements.md` asks: nothing missing, nothing extra, nothing subtly wrong? |
| **standards** | Does it follow this repo's written conventions, and is it free of obvious design smells? |
| **break-it** | Can the change be made to fail? Every finding must come with the command that shows it. |

```
orch run .orch/plan.json --only review-spec,review-standards,review-break
```

The router gives a review to a different vendor than the author where it can.

## 2. Judge the findings, then rework

Keep the three reports apart. A change can meet the spec and break the conventions, or the reverse, and merging the lists lets one hide the other.

For each finding, decide on its merits. Reviewers are often wrong:

- **break-it:** rerun the command yourself. Keep the finding only if the output shows the failure and the failure breaks a requirement.
- **spec:** check the quoted requirement against the diff.
- **standards:** a breach of a written rule is a finding. A smell is a judgement call: act on it when the fix is clearly better, and let it go otherwise.

Findings you keep go into one **rework** task, appended to the plan. Its brief lists each finding and says to fix those and nothing else: a rework that wanders is how a reviewed change turns into an unreviewed one. Run it with `--only`, then return to stage 5.

After a rework, check only what the rework was for: rerun each kept finding's command, or reread the lines each one named, and confirm it is gone. Do not run the three reviewers again over the whole diff. A fresh full review always finds something new to say, so a loop that waits for a clean one never ends. One full review, then targeted confirmation of each fix, is the whole of automated review.

A finding that shows the requirements or design were wrong is not rework. Take it back to stage 1 or 2 and to the user.

Three rework rounds is the limit. If findings remain after the third, stop here and go to step 7 with them listed.

## 3. Open the PR

Run `orch lint` and fix what it reports before you push: commits cannot be reworded once others have them.

Push the branch, then open the PR. The title is a conventional commit header that ends with the key, because a squash merge turns it into the commit on the main branch, and Jira links a PR by the key in its title or branch:

```
orch lint --title "feat(api): add rate limiting (ACME-412)" --key ACME-412
gh pr create --title "feat(api): add rate limiting (ACME-412)" --body "<body>"
```

The body, in this order:

```markdown
## Why
One or two sentences and a link to the ticket.

## Summary
The smallest picture that makes the change clear: a short diff sketch, a call tree, or a few lines of pseudocode.

<contents of .orch/verification.md, unchanged>

## Merge danger
**Door:** one-way or two-way, and why.
**Blast radius:** what else could be affected, and how you would know.

## Needs a decision
Anything still waiting on a person.
```

The verification report is the evidence, so it goes in whole. Keep your own sections short.

## 4. Fix what CI and outside reviewers find

```
orch pr feedback <pr-number> --wait 20
```

It waits for CI and review bots, then lists what still needs an answer. Treat each as in step 2:

- **Right:** fix it, as a rework round. Then `orch pr reply <thread-id> "<what changed>" --resolve`.
- **Wrong or out of scope:** `orch pr reply <thread-id> "<why not>"` with a concrete reason, and leave it for the reviewer to resolve.
- **Failed check:** read it with `gh run view --log-failed` and fix the cause.

Security, auth, billing, data loss and migrations are never dismissed on your own judgement: fix them or raise them.

After every push, run `orch verify .orch/plan.json --prove --repeat 2` again. A verdict belongs to the commit it ran on.

These rounds count toward the same limit of three.

## 5. Publish the gate

```
orch pr gate <pr-number> [--approve human|observe|auto]
```

This puts one status on the PR, `orch/verification`, and a comment with the report. `success` means every criterion passed, CI is green, nothing is unanswered, and the verdict is for the PR's current commit. `pending` means it is waiting on a person, a reviewer or a running check. `failure` means a criterion or CI failed.

Who approves is the user's setting. `human`, the default, leaves the PR for a person. `observe` does the same and records when it would have merged. `auto` enables GitHub auto-merge on `success` only. Merging, approving or enabling auto-merge any other way is outside what this skill may do.

## 6. Hand over for human acceptance

A person decides what automation cannot: whether this is worth shipping, whether it feels right to use, whether the exceptions are acceptable, whether now is the time to release. Do the maximum before involving them, then ask once, with everything prepared. Give them a brief they can decide from without opening anything else:

```markdown
**<KEY>: <summary>**: <PR link>
**Gate:** success | pending | failure - <one line why>
**What it does:** two sentences, in the user's terms.
**Evidence:** the criteria that passed and how; the before and after.
**Your call:** each thing only they can judge, with what to look at.
**Risk:** one-way or two-way door; blast radius.
**Not done:** findings left open, tasks waiting on a person, anything declined and why.
**Cost:** spent versus estimated.
```

## 7. Alert and close

Unless `--no-alert`, send `orch notify "<KEY>: <gate state>, <what is needed from them> <url>"`. Send it when you stop early too.

Then, if anything in this run went wrong in a way a check could have caught (a reviewer or CI found a bug the criteria missed, a worker repeated a mistake), say what the check would be and offer `/orch-retro`. What one run teaches should make the next run's checks better.
