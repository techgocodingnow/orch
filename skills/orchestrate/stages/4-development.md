# Stage 4: Development

**In:** `.orch/plan.json` that routes to START. **Out:** commits on a feature branch. **Ends when** every task that is not waiting on a person is `done` with its own check passing.

## 1. Start clean

Work on a fresh branch off the up-to-date default branch. Let `orch` name it, so the type matches the commits and the Jira key is where Jira looks for it:

```
git switch -c "$(orch branch <type> <KEY> <short summary>)"     # feat/ACME-412-add-rate-limiting
```

`<type>` is the conventional commit type of the main change (`feat`, `fix`, `refactor`, `docs`, `test`, `chore`, ...). Without a ticket, leave the key out: `fix/rename-store-type`. If the repo has its own commitlint config, `orch` uses its types.

If the tree has uncommitted changes that are not yours, stop and ask: building on top of them would mix someone else's work into the PR.

## 2. Run the plan

```
orch run .orch/plan.json [same flags as the route]
```

This blocks until every task has ended, so give it a long timeout or run it in the background. Each task runs in its own sub-session on the model the router chose. Read tasks run in parallel; write tasks take turns in the shared checkout, or run in parallel when isolated in a worktree.

`orch run` handles the first layer of the loop itself: when a task's check fails, it sends the output back to a worker, up to three times, the last on a stronger model. A task whose check still fails after that ends as `failed`.

Each task's report lands in `.orch/runs/<run>/<task>.result.md`.

## 3. Read what came back

A report is a claim. For each task:

- Read the report, then read the diff it produced. Check that the diff does what the brief asked and stays inside its scope.
- If workers used worktrees, merge their `orch/<run>/<task>` branches in dependency order and resolve conflicts.
- Note anything a worker flagged as open, wrong, or beyond its brief.

## 4. Deal with what did not finish

- **A failed task:** read its log. If the brief was unclear or wrong, fix the brief. If the task was too big, split it. Then run just that task and whatever depends on it: `orch run .orch/plan.json --only <ids>`. If three rounds of fixes did not get its check to pass, a fourth run of the same brief will not either: raise it to the user with the check's output.
- **A task waiting on a person:** it and its dependents are skipped. Carry on with the rest and bring it up in the brief at the end.
- **A worker says a check is wrong:** it may be right. Do not edit the check. Tell the user what the worker found and let them decide.

## 5. Commit

Commit in small, ordered commits. Each message follows Conventional Commits, as commitlint checks it, and names the ticket in a footer so Jira links the commit:

```
feat(api): add per-user rate limiting

Counts requests per authenticated user, falling back to IP.

Refs: ACME-412
```

- Header `<type>(<scope>): <subject>`, at most 100 characters. Scope is optional: the area of the code, not the ticket.
- Subject in the imperative, lower case, no full stop: "add x", not "Added x."
- `!` after the type, plus a `BREAKING CHANGE:` footer, for a change that breaks callers.
- If the repo has a commitlint config, its rules win over these.

`orch lint` checks the branch name and every commit since the base. Run it before stage 5; Reword a bad message only while the branch is unpushed: `git commit --amend` for the last commit, or `git reset --soft <base>` and commit again in order. For a bug fix, the commit that adds the failing test comes before the commit that fixes it, so the history itself shows the test catching the bug.

The stage is done when every runnable task is `done`. Go to stage 5.
