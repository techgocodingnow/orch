---
name: orch-setup
description: One-time setup for /orchestrate. Checks the agent CLIs, GitHub login, the Atlassian (Jira) connector in each agent, and alerts, and walks the user through fixing whatever is missing. Use when the user types /orch-setup, or when `orch setup --check` fails.
---

# Orch setup

Run this once per machine. Later runs of `/orchestrate` only check a stamp file.

```
orch setup
```

It prints one line per check. `✖` is required, `!` is optional. Take the lines that are not `✔` one at a time; each prints its own fix. Where there is a choice to make, lead with the answer you recommend so the user can accept it in a word.

**Agents.** At least one of Claude Code or Codex must be installed and logged in. More agents give the router more models to choose from.

**GitHub.** The `gh` CLI must be logged in: `gh auth login`. It opens PRs and reads review feedback.

**Jira.** Each agent uses its own Atlassian connector, so there is no token to manage. The user has to do the sign-in, because it opens a browser:

- Claude Code: run `/mcp`, pick Atlassian, sign in. If Atlassian is not listed, enable it at claude.ai/settings/connectors, or add it with the command `orch setup` prints.
- Codex: run the `codex mcp add` and `codex mcp login` commands that `orch setup` prints.

Only the agent the user types `/orchestrate` into needs the connector. It is optional: without it `/orchestrate` still takes a task in plain words.

After the user signs in, confirm it works by reading one real issue they name through the connector.

**Alerts.** A desktop notification is on by default. For a chat alert, ask the user for a Slack or Discord incoming-webhook URL and run `orch setup --webhook <url>`. Skip it if they do not want one.

**Models.** Run `orch detect` and `orch roles`. `orch roles` shows which model each kind of task gets at each size under the current settings. With nothing set, every task goes to the best-quality model for it. Show the user that table and say so. Both of these are optional, so offer them once and move on if the user has no preference:

- A spending level, to trade quality for cost or speed: `cheap`, `balanced` or `fast`. Save it with `orch setup --profile <choice>`. `orch setup --clear-profile` goes back to best quality.
- A fixed model for one kind of work, for example every review on Opus. Save each with `orch setup --role review=claude/opus@high`. `orch setup --role review=` removes one.

Only what they change is written. Everything else keeps following the router, so a new default reaches them without another setup. If `orch detect` notes that an agent's own default model is not available, tell them.

**Approval.** By default a PR that passes verification waits for a person to approve it. Ask once whether they want passing PRs to merge by themselves. Recommend `orch setup --approve observe` first: nothing merges, and each gate records whether it would have, so after a few PRs they can see if the gate agrees with their own judgment. Only on a clear yes to merging: `orch setup --approve auto`. That enables GitHub auto-merge on PRs whose every criterion passed, so tell them it needs auto-merge allowed in the repository settings, and that branch protection still applies. `orch setup --approve human` turns it back off.

**Project standards.** `/orchestrate`'s reviewers read the repo's written standards (`CODING_STANDARDS.md`, `CONTRIBUTING.md`, `REVIEW.md`) and its standing checks (`orch.checks.json`). A repo with none still works: the reviewers fall back to a general baseline. Mention that these files exist as places to steer reviews, and that `/orch-retro` proposes entries for them from real runs. Do not create them now: a rule nobody has needed yet is a rule nobody will keep.

Setup is done when `orch setup --check` exits 0. Tell the user what is ready, which optional pieces are still off and what each would add, and that they can start with `/orchestrate <JIRA-KEY>`.
