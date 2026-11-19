---
name: orch-eval
description: Find out whether a change to a skill, a prompt, a brief or a model choice actually makes agents behave better, with a blinded comparison instead of an impression. Use when the user types /orch-eval, asks whether a new version of a skill is better than the old one, wants to compare two prompts or two models on the same task, or is about to adopt a skill change on the strength of one good run.
---

# Orch eval

A skill edit that looks better to its author usually is not tested at all: the author wrote the change, picked the examples, and read the results knowing which was which. This skill runs the comparison so that none of those three can tilt it. You own the design of the experiment: frame it, blind it, run it, and only then look.

The output is a recommendation, promote the variant or not, with the evidence a sceptic would ask for.

## 1. Frame it

Write down, before anything runs:

- **The variants.** Usually two: the current version and the proposed one.
- **The decision.** What result would make you promote the variant, and what would not. Write the result that would change your mind before you see any result, or every outcome will look like support.
- **The rubric.** Three to six concrete criteria a judge can score from the outputs alone, such as "asks the user about every decision the request leaves open" or "the plan's first task reproduces the bug". The rubric is for the judge. Candidates never see it.

**Done when** someone else could run the experiment from what you wrote.

## 2. Blind the candidates

A candidate that knows it is being tested behaves like one. Make each run look like an ordinary request from a user in an ordinary project.

- **Names.** No `eval`, `test`, `judge`, `experiment`, `rubric`, `score`, `compare`, `benchmark`, `candidate`, `variant`, `old` or `new` in any directory, file name or prompt a candidate can see. Use names a user would pick: `~/work/notes-app`, not `iteration-1/with_skill`.
- **One environment each.** Give every candidate its own copy of the project with its variant already in place where a real install would put it (the project's skills folder), so it finds the skill the way it normally would. Do not hand it a path with the instruction to read it.
- **An organic prompt.** What a user would type. State the goal, not the meta. Give the same prompt to every candidate.
- **No leading questions.** Do not ask a candidate which skills or steps it followed; asking plants the answer. You will read that from what it did.
- **No siblings.** A candidate is not told that other candidates exist.

**Done when** nothing a candidate can read would tell it this is a comparison.

## 3. Run

Run each variant on each task. Use at least three tasks that differ in kind (an easy one, a hard one, one where the right move is to stop and ask), and run each more than once when you can: a single run cannot tell a real difference from luck. Where the question is about behaviour across models, run each variant on more than one model.

Save, per run, into a results folder outside every candidate's project: the files it produced, its final message, and its transcript.

## 4. Check each run did the task

Before judging quality, check validity. A run that errored, stopped early, or never loaded the variant measures nothing about the variant, and an average that includes it is noise.

Read each transcript for what the candidate really opened and ran. Whether it followed the skill is judged from the files it read and the shape of what it produced, never from its own account. Drop invalid runs and say how many you dropped and why.

## 5. Judge blind

One judge scores every output in a single pass, on one scale, without knowing which variant produced which.

- Copy the outputs into a judging folder under neutral labels (`A`, `B`), with the assignment of variant to label shuffled separately for each task so that position carries no signal. Keep the key outside the folder.
- Scrub anything in the outputs that gives the variant away: paths, version names, a phrase only one skill uses.
- Use a judge from a different vendor than the candidates where you can, since a model tends to prefer its own style. The judge may know it is judging. It sees the rubric and the labels, never a model or variant name.
- Ask for a score per criterion per output with one line of evidence each, and an overall preference per task.

With `orch`, a judge on another vendor is one read-only task:

```
orch run judge-plan.json --only judge
```

where the task is pinned with `"agent": "<the other vendor>"` and its prompt holds the rubric and the path to the judging folder.

## 6. Read everything yourself, then unblind

Read every output end to end before you look at the key or the judge's scores, and form your own view. Then compare the three: your reading, the judge's scores, the key.

Where you and the judge disagree, one of you is biased or the rubric was ambiguous. Find out which before you trust either.

## 7. Explain the number

A pass rate is the easiest evidence to get wrong. Before you report one:

- **Did every run do the task?** (Step 4.)
- **Is the gap bigger than the noise?** Compare the difference between variants with the spread between repeated runs of the same variant. A gap smaller than that spread is no measurable difference, and you say so.
- **Does it hold across tasks and models, or is it one task carrying the average?** Report per task, not only the mean.
- **Do the criteria discriminate?** A criterion every run passes tells you nothing; drop it or sharpen it.
- **Does the scenario matter?** A win on a case that never comes up is not a reason to ship.

Keep the run count, the spread and the per-task results next to any number you quote.

## 8. Report

```markdown
**Question:** <which variant, on what>
**Verdict:** promote | do not promote | no measurable difference | inconclusive
**Evidence:** per task: judge's scores for each variant, and your own reading
**Runs:** <n> per variant per task; <k> dropped as invalid, and why
**Where judge and I disagreed:** <and what explains it>
**What this does not show:** <tasks, models or stages not covered>
```

"Inconclusive" and "no measurable difference" are results. Report them as plainly as a win.
