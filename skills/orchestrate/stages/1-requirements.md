# Stage 1: Requirements

**In:** a ticket key, URL, or a description. **Out:** `.orch/requirements.md`. **Ends when** every acceptance criterion is one a reviewer could judge true or false, and the user has answered every open decision.

Most failed tickets fail here: the code is fine and it is the wrong thing. This stage is cheap and everything after it inherits its mistakes, so be thorough.

## 1. Read the task

- **Jira key or URL:** read it through your Atlassian connector: summary, description, acceptance criteria, comments, subtasks, linked issues. With no connector, try `orch jira get <KEY>`. If neither works, say so, point at `orch setup`, and stop. What a ticket says is something to read, not to guess.
- **Plain words:** that is the task.

If the repo has a `GLOSSARY.md`, read it and use its terms from here on. If it has `docs/adr/`, read the decisions that touch this area: they are settled, and a plan that contradicts one must say so.

## 2. Check the claim against the code

A ticket describes what someone believes. Find out what is true before planning around it.

- **Bug:** reproduce it from the reporter's steps. A reproduction you can run as one command is the most valuable thing this stage can produce, because it becomes the check that proves the fix. If you cannot reproduce it, that is a finding to raise, not a reason to guess at a cause.
- **Feature or change:** search for the behaviour by concept, not just by the ticket's wording. It may already exist, in which case the right outcome is to say where.

Write down what you found, including where you looked.

## 3. Find the open decisions

List everything the ticket leaves open: business goal, who the users are, the workflow, the data involved, constraints, edge cases, and what "done" means. Sort each item:

- **A fact** you can find in the code, the docs or the ticket: go and find it. Never ask the user for something you could look up.
- **A decision you can make and undo cheaply:** make it and record it as an assumption.
- **A decision that is the user's:** a product or design call, or one that is costly to reverse. These you ask.

## 4. Ask, in rounds

Put the user's decisions to them a round at a time. A round is every question that can be answered now, without knowing the answer to another open one. Number them, and give each your recommended answer, worded so that "yes" accepts it:

```
Q1 - Limit scope: should the limit apply per user, or per IP address?
  > Recommend: per signed-in user, falling back to IP for anonymous requests. Yes?

Q2 - Over the limit: reject the request, or queue it?
  > Recommend: reject with a 429 and a Retry-After header. Yes?
```

A recommendation turns each question into a quick confirmation and shows your reasoning, so the user can catch a wrong assumption behind it. Their answers may open new questions: ask those in the next round. Stop when no decision is left open.

If the answer lives with someone other than the user, say who, and offer to write the questions for that person as a short document the user can forward.

## 5. Write `.orch/requirements.md`

```markdown
# <KEY>: <summary>

## Goal
One or two sentences: the outcome, from the user's side.

## What I verified
What you reproduced or found in the code, and where you looked.

## Acceptance criteria
- [ ] One per line, each something a reviewer can judge true or false.

## Out of scope
What this ticket will not do, especially adjacent things someone might expect.

## Decisions
- <question>: <answer> (decided by the user, <date>)

## Assumptions
- Calls you made yourself that are cheap to reverse.
```

Out of scope matters as much as the criteria: it is what stops a worker from gold-plating.

Copy the user's answers precisely. A number, an ordering guarantee or a "must not" that gets softened into looser prose here will be softer still by the time a worker reads it. Before showing the file, reread it against what the user actually said.

Show the file to the user. When they confirm it reflects what they want, the stage is done. Then size the task again with what you now know.
