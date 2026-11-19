# Stage 2: Design

**In:** `.orch/requirements.md`. **Out:** `.orch/design.md`. **Ends when** every hard-to-reverse decision is settled by the user, and the seams to test at are named.

The aim is to find the few decisions that are expensive to change later and settle them before any code exists. Everything cheap to change is left to the workers.

For a small standard ticket this stage is a few lines. Write them anyway: naming the seam to test at is what makes stage 3 able to write a real check.

## 1. Trace what the change touches

Follow the affected path through the code: where requests or calls enter, which modules own the data, what else reads or writes it. Note anything outside the diff that depends on it: other callers, stored data, wire formats, feature flags, pinned library versions.

## 2. Decide the shape

Write down, as far as each applies:

- **Modules** to add or change, and what each is responsible for.
- **Interfaces:** what callers must know: signatures, data shapes, error cases, ordering.
- **Entities and data:** new or changed fields, and what happens to existing rows.
- **Permissions:** who may do the new thing.
- **Deployment:** migrations, flags, config, order of rollout.

Describe behaviour and interfaces. Leave file paths and line numbers out: they are the first thing to go stale.

## 3. Name the seams

A seam is the public boundary where behaviour can be observed without reaching inside: an HTTP route, a CLI command, an exported function. For each acceptance criterion, name the highest seam at which it can be checked. Prefer a seam that already has tests. The fewer seams, the better: one is ideal.

This list is what stage 3 turns into checks. If a criterion has no seam it can be observed at, say so: that is a design problem to solve now, not a testing problem to discover later.

## 4. Separate the one-way doors

For each decision, ask whether it could be walked back after merge. Two-way doors you decide yourself. A one-way door goes to the user, with your recommendation: a schema or data migration, a public API or wire-format change, deleting or rewriting data, a new external dependency, anything touching auth, billing or security.

Ask in the same round format as stage 1.

If a design question cannot be settled on paper (does this state model hold up, which of two interfaces is easier to use), build a throwaway prototype of each option and compare them, then keep only the decision. When an interface is genuinely contested, sketch two different shapes and pick the one where each piece of state has one owner and callers need to know least.

## 5. Record what future readers will need

Offer to record a decision as an ADR in `docs/adr/` only when all three hold: it is hard to reverse, it would surprise a reader who lacked the context, and it was a real choice between alternatives. An ADR can be one paragraph. When the grilling settled the meaning of a project term, add it to `GLOSSARY.md`.

## 6. Write `.orch/design.md`

```markdown
# Design: <KEY>

## Shape
Modules, interfaces, data, permissions, deployment: only the parts that apply.

## Seams
- <acceptance criterion> -> checked at <seam>

## One-way doors
- <decision>: <what was chosen, and who decided>

## Blast radius
What outside the diff depends on this, and the one fact its safety rests on.
```

The stage is done when the one-way doors are all decided by the user and every criterion has a seam or an agreed reason it has none.
