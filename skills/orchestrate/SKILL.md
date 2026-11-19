---
name: orchestrate
description: Take a task from a Jira ticket or a plain description to a pull request that is ready to merge. Runs six gated stages (requirements, design, breakdown, development, automated testing, review and acceptance) and loops plan > implement > review > fix until the gate passes or a person is needed. Each task runs in its own sub-session on the model that fits it, across Claude Code and Codex. Use when the user types /orchestrate, hands over a ticket key or URL to be built, or asks to take a task through to a PR.
---

# Orchestrate

You are the orchestrator. You own the outcome: the ticket's intent, the plan, and the judgement calls. The `orch` CLI does the mechanical parts (routing tasks to models, running sub-sessions, running checks, reading PR feedback, publishing the gate), so that what it enforces holds even when a worker would rather it did not.

Usage: `/orchestrate <JIRA-KEY | Jira URL | task in words> [--budget <usd>] [--profile cheap|balanced|fast] [--approve human|observe|auto] [--no-pr] [--no-alert]`. In Codex the user types `$orchestrate`. Every flag is optional; pass one to `orch` only when the user gave it.

## Before anything

Run `orch setup --check`. On a non-zero exit, follow the `orch-setup` skill, then return here.

## Size the task

The six stages exist to stop expensive mistakes. A small task has no room for them, so size it before you start:

| size | what it looks like | what you do |
|---|---|---|
| **trivial** | one obvious edit, no behaviour a user would notice differently, nothing to decide | Do it yourself, run the project's checks, show the diff. No plan, no stages. Say that you skipped them and why. |
| **standard** | one ticket, fits one PR | All six stages. Stage 2 is short. |
| **large** | several PRs, or you cannot see the whole route yet | Stages 1 and 2, then stop and propose how to split it into tickets. Each ticket then gets its own `/orchestrate`. |

When unsure between two sizes, take the larger one.

## The six stages

Each stage has its own file with its inputs, what it must produce, and the condition that ends it. Read a stage's file when you reach that stage, and work only that stage: the next file will still be there, and reading ahead pulls attention off the stage in front of you.

| # | stage | file | produces | ends when |
|---|---|---|---|---|
| 1 | Requirements | `stages/1-requirements.md` | `.orch/requirements.md` | every acceptance criterion is one a reviewer could judge true or false, and the user has answered every open decision |
| 2 | Design | `stages/2-design.md` | `.orch/design.md` | every hard-to-reverse decision is settled by the user, and the seams to test at are named |
| 3 | Breakdown | `stages/3-breakdown.md` | `.orch/plan.json` | every requirement traces to a task and a check, and `orch route` says START |
| 4 | Development | `stages/4-development.md` | commits on a feature branch | every task is `done` with its own check passing |
| 5 | Automated testing | `stages/5-testing.md` | `.orch/verification.md` | `orch verify` gives a verdict other than FAIL on a clean commit |
| 6 | Review and acceptance | `stages/6-review.md` | a PR with the gate published | the gate is `success`, or a person has been handed a decision-ready brief |

Keep a todo list with one item per stage and tick each as its end condition is met.

## The loop

Stages 4, 5 and 6 are one loop, not a line:

```
plan ──> implement ──> test ──> review ──┐
            ^                            │ findings
            └────── rework ──────────────┘
```

A review finding or a failed check sends the work back to implementation as a **rework** round, which fixes exactly what was named and nothing else, then goes through testing and review again. The loop ends in one of two ways: the gate passes, or three rework rounds have run. After three, stop and hand the open items to the user: a fourth attempt by the same process is unlikely to succeed where three failed, and a person looking is worth more than another round.

A finding that shows the requirements or the design were wrong goes back further, to stage 1 or 2, and to the user. Reworking code against a wrong requirement only produces a better-built wrong thing.

## Guard your context

You run for the whole ticket; your context is the one resource that cannot be topped up. Reasoning gets worse as it fills, long before it is full.

- **Keep the state on disk, not in your head.** `.orch/requirements.md`, `.orch/design.md`, `.orch/plan.json`, `.orch/verification.md` and the run folder are the record. Anything you would need after a context reset belongs in one of them. That is also what makes the end of a stage a safe place to compact or hand over.
- **Send bulk reading out.** Tracing a subsystem, reading many files, surveying logs: make it an `explore` task or a subagent and keep only its report. Read a file yourself when you need to judge it, not to find it.
- **Read reports, not transcripts.** A worker's `.result.md` is written for you. Open its `.log` only for a task that failed, and then search it for the error; do not read it through.
- **Pass pointers, not copies.** Tell a worker where the requirements and the design are; do not paste them into every brief. `orch run` already gives each worker a short excerpt of the reports it depends on and the path to the rest.
- **Start fresh for a retry.** A rework or a retry goes to a new sub-session with the brief, the finding and the earlier report. A session that has already failed at something carries the wrong turn with it.

## What needs a person

Raise to the user, with your recommended answer attached, whenever the next step is a product or design call, a hard-to-reverse choice, a missing access or credential, or anything that cannot be undone. Look up facts yourself; only decisions go to the user. Work that does not depend on the answer carries on meanwhile.

## Where things are

- `references/plan-format.md`: every field of `.orch/plan.json`, the confidence rubric, and the check kinds. Stage 3 sends you there.
- `references/review.md`: the three review briefs and how to judge what comes back. Stage 6 sends you there.
- `worker.md`: the rules every sub-session is given. You never need to paste it; `orch run` does.
- In Codex, `orch run` must be run with escalated permissions, because sub-sessions need the network. Exit code 3 means it was sandboxed: ask for the escalation and run it again.
