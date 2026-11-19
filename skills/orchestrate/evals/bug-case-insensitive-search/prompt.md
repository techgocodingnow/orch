---
tags: [skill-creator]
max_turns: 40
timeout_seconds: 900
allowed_tools: [Read, Glob, Grep, Skill, Write, Edit, Bash]
---

/orchestrate Bug report from a user: `node notes.mjs search milk` finds nothing even though I have a note that says "Buy Milk". Search should not care about upper or lower case.

Constraints for this session: the user is away and cannot answer. If you need a decision from them, write your questions exactly as you would put them to the user in a file named QUESTIONS.md and stop there. Do not start any sub-sessions: never run `orch run`. Do not push or open a pull request. If you get as far as a plan, stop after `orch route`.

Input files: notes.mjs, notes.test.mjs, package.json, README.md, .gitignore
