---
name: orch-me
description: Draft or update the user's personal `<name>-mode` skill from how they have actually worked, by reading their own messages in recent Claude Code and Codex sessions. The mode skill carries their preferences and runs tasks through /orchestrate. Use when the user types /orch-me or asks to capture their working style as a skill.
---

# Orch me

Turn the user's working habits into one skill, `<handle>-mode`, that every agent follows. It holds their rules and hands the work to the `orchestrate` skill. `orchestrate` stays the base; the mode skill is the user's layer on top.

## 0. Is there one already?

Pick the handle: the user's first name or the name they give. Look for `~/.agents/skills/<handle>-mode/SKILL.md`, then the same name under `~/.claude/skills` and `~/.codex/skills`.

If it exists, update it in place unless the user asks to start over. Then step 1 reads only sessions newer than the file, step 2 asks what changed, and step 4 keeps every section the new evidence does not contradict.

## 1. Mine their history

```
orch transcripts --days 30
```

It prints only what the user typed, in this project, from both agents. Reading other projects needs their consent: ask before adding `--all`. If there are more than a few hundred messages, split them by date into three slices and give each to a subagent.

Look for what repeats:

- **Corrections.** "No, don't…", "I said…", the same fix asked for twice. These are the strongest signal.
- **How they ask.** Language, length, how much detail they give, what they leave unsaid and expect anyway.
- **What done means.** Tests, a live run, a PR, a review by another model.
- **Process.** Branch names, commit and PR style, when to ask and when to go ahead, what must never happen without them.
- **Cost and models.** A budget they keep setting, a profile, a model they pin for one kind of work.
- **Reply style.** Length, tables or prose, language of the reply.

Keep a pattern only if it shows up in two or more sessions. Write each with one quoted example and its date. Something said once is noise.

## 2. Ask them

History misses what has not come up. Ask one or two multiple-choice questions on the areas where the evidence was thin, then one open question: "anything I should always or never do?" Do not ask more.

## 3. Draft

Write `~/.agents/skills/<handle>-mode/SKILL.md`:

```markdown
---
name: <handle>-mode
description: <Handle>'s working style. Use when the user types /<handle>-mode or asks to work in <Handle>'s style.
---

# <Handle> mode

Apply these rules, then follow the `orchestrate` skill for the task itself. Where a rule here and that skill disagree, the rule here wins.

## Orchestrate defaults
Flags to pass unless the user says otherwise, such as `--profile cheap --budget 3`.

## <one section per area that has real rules>
```

Rules for the draft:

- A section exists only if the user has a specific rule that differs from the default. "Communicate clearly" is not a rule. "Reply in Vietnamese. Tables for comparisons." is.
- Every line is an instruction an agent can act on. No evidence, no quotes, no history.
- Point at other skills by name. Do not paste their content.
- Say "the user", not their name, inside the rules.
- Under forty lines. This is not a manual.

Model choices that should hold for every task do not belong in the skill. Save them with `orch setup --profile <p>` and `orch setup --role <kind>=<model>`, and say you did.

## 4. Show, revise, link

Show the draft with, for each rule, the evidence it came from. Take corrections and cut whatever they do not recognise as theirs. Expect two or three rounds.

When they accept it:

```
orch link ~/.agents/skills/<handle>-mode
```

That makes it available in Claude Code and Codex. Tell them to start a new session and type `/<handle>-mode <task>` (`$<handle>-mode` in Codex).
