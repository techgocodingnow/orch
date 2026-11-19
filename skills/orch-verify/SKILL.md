---
name: orch-verify
description: Create or maintain this project's own verify skill, the scripted way to start the real app, drive a feature the way a user does, and capture proof. /orchestrate uses it to write end-to-end checks for a PR. Use when the user types /orch-verify, when `orch verify-skill` reports the project has none or that it is stale, or when a ticket needs an e2e check and the project has no way to run one.
---

# Orch verify

A unit test can pass while the feature is broken. The check that is hard to fool runs the real app and does what a user would do. This skill gives a project that ability once, as a project-local skill named `verify-<app>`, so every later PR can prove its behaviour instead of asserting it.

You write `verify-<app>` for the next agent, not for a person. It will be read cold, mid-task, by an agent that has never seen the app.

Start with:

```
orch verify-skill
```

- `missing`: follow **Create**.
- `stale` or `unsynced`: follow **Maintain**.
- `current`: nothing to do. Say so and stop.

## Create

### 1. Learn the app from the repo

Answer these from the code. Ask the user only what you cannot observe.

- **Surface.** What does a user touch: a web UI, an API, a CLI, a mobile or desktop app, a library? Pick the main one and note the others.
- **Run.** How does it start locally? Use the repo's own command (package scripts, Makefile, README). Note ports, env vars, seed data and auth.
- **Drive.** How can an agent operate it? Prefer what the repo already has: Playwright or Cypress specs, an HTTP client, a CLI entry point. Only then add a generic route: a browser driver for web, plain HTTP for a service, a pseudo-terminal for a CLI.
- **Observe.** What proof can be captured: response bodies, screenshots, terminal output, logs, exit codes, database rows?
- **Isolate.** Can two copies run side by side on different ports and data folders? If not, write that down: the skill must refuse to drive an instance someone else is using.

If the checkout does not build or start, fix that first or report it exactly. A skill written against a broken base teaches wrong steps.

### 2. Write the skill

Create `.claude/skills/verify-<app>/SKILL.md`, then link it for other agents: `mkdir -p .agents/skills && ln -s ../../.claude/skills/verify-<app> .agents/skills/verify-<app>`.

Frontmatter, all four lines required:

```
---
name: verify-<app>
description: Start <app> and prove a feature works by driving its <surface>. Use before opening a PR that changes behaviour.
covers: src/**, app/**
sync: <the commit you proved it at>
---
```

`covers` is the code this skill describes, as comma-separated patterns. `sync` is the commit where you last confirmed the skill matches that code. `orch` compares them to tell when the skill has gone stale.

Sections, each with this repo's real commands, paths and names, and no placeholders:

- **Launch.** The exact command, and how to tell it is ready. Ready means usable from an empty data folder, migrations and seed data included, not just that a port answers. Include teardown.
- **Doctor.** One read-only command that answers "is this instance worth driving?": the process is up, it is our build, we own the port, auth is valid. Run it before the first drive and after any drive that fails.
- **Drive.** How to operate it, with real selectors, routes or commands. Prefer stable handles (labels, data attributes, route paths) over coordinates.
- **Evidence.** What to capture and where it goes. The standard:
  - Use the real user path, not internal setters or test-only endpoints.
  - Capture the action and the resulting state, not only the final screen.
  - For anything that changes data, confirm the stored value through a second, read-only view.
  - Check side effects (files written, rows inserted, messages sent) as well as what is visible.
  - Record which feature and which entry point each artifact proves. A feature reached one way is proven for that way only: an entry point that was skipped is reported as skipped with the reason, never as verified through a different path.
  - Mock only where production already isolates an outside system. If the safe route is a dry-run or test mode, observe what it really skips; some dry-runs still touch the network.
- **Check command.** One command per feature that exits 0 only when the feature works, so a plan can use it directly as an `e2e` check. Show the exact form, such as `npm run e2e -- checkout`.
- **Cleanup.** Stop only what this run started, never by process name. Cleanup never deletes the evidence.

Any helper script the skill ships is executable and its invocation is shown in the skill.

### 3. Seed the feature map

Create `features/README.md` beside the skill as an index, plus one file per user-facing feature. Start with the three to five that matter most, found from routes, commands, menus or docs. Each file answers, from the user's side:

- what the feature is and its sub-features,
- how a user gets to it,
- how to drive it with this harness,
- what observable end state proves it works,
- gotchas.

If the seed data lacks something a journey needs, the journey fails and the reason goes under gotchas. Never weaken a journey to make it pass.

The map is both a guide and a grading rubric: it is where a planner looks up how to check a ticket.

### 4. Prove it before you hand it over

Follow your own skill once, start to finish, as the next agent would: launch, doctor, drive one mapped feature, capture evidence, clean up. Then:

- Confirm the evidence is still there after cleanup.
- Break the feature in the code on purpose, run its check command, and confirm it fails. Undo the break and confirm it passes again. A check you have never seen fail proves nothing.
- Run cleanup after every failed attempt too, so nothing is left holding a port.

A verify skill that was never run is a draft. If you proved it against a stand-in for the real target, list every step the stand-in did that the real target will not.

Set `sync` to the commit you proved it at. Tell the user what it covers, what it does not, and how to run one feature's check.

## Maintain

The dangerous case is a check that keeps passing while it describes an app that has changed.

1. `orch verify-skill` lists the covered files that changed since `sync`. Read those changes.
2. **Index.** Fix missing, duplicate or dead entries in the feature map.
3. **Source pass.** For each feature file, compare it with the code. Note what has drifted. If the changes are many, give each feature file to a read-only subagent.
4. **Live pass.** Required even when the source looks unchanged. Launch, doctor, and drive every mapped feature once.
5. **Sort what you found:**
   - The description is wrong: fix the map.
   - The app works but the harness cannot drive it: fix the harness, then drive it again before you call it fixed.
   - The app is broken: that is a product bug. Report it to the user. Do not paper over it in the map, and do not fix product code in this pass.
6. For any check you changed, break the feature and confirm the check still fails.
7. Set `sync` to the commit you checked. Do not move it for a feature you could not drive: mark that feature unreachable with the exact prerequisite that was missing.

Edit only the verify skill's own folder. Put the result in one change of its own, separate from any product fix. Report one of: clean (nothing to change), changed (what you corrected), blocked (exactly what stopped you).
