---
name: encode-project-learning
description: Convert durable lessons discovered while implementing, debugging, investigating, or reviewing a codebase into repository infrastructure that helps future contributors and agents. Use when work reveals a recurring failure mode, hidden domain rule, surprising architectural constraint, repeated manual step, missing validation, undocumented convention, reviewer correction, or other knowledge worth preserving as types, tests, lint rules, CI checks, tooling, agent instructions, review guidance, documentation, or comments. Also use at the end of substantive coding or review work when it surfaced concrete evidence of a reusable lesson.
---

# Encode Project Learning

Turn repository discoveries into the strongest practical safeguard. Solve the immediate task first, then prevent the same class of friction or failure from recurring.

## Respect Scope

Match the action to the user's authorization:

- For implementation or fix requests, make small related safeguards and documentation updates when they are clearly within scope.
- For diagnostic, explanatory, or review-only requests, report the proposed learning update instead of changing files unless the user also authorized changes.
- Request direction before establishing a broad architectural, product, security, or process policy that is not already supported by repository evidence.
- Preserve unrelated user changes and follow repository-local instructions.

Do not let this review displace the requested work. Treat no durable update as a valid result.

## Run the Learning Loop

### 1. Notice friction

Look for discoveries such as:

- A defect pattern that could recur elsewhere
- An invariant, domain rule, or framework requirement that was not apparent
- Reviewer feedback that could have been predicted before review
- A manual check or setup step that contributors repeatedly perform
- A repository convention that required archaeology or private context
- Misleading, missing, duplicated, or stale guidance
- A useful command or workflow that was difficult to discover

Do not treat ordinary implementation effort, speculative preferences, or isolated accidents as durable learning.

### 2. Gather evidence

Before encoding a rule:

- Search for related code, tests, configuration, instructions, and documentation.
- Determine whether a canonical rule already exists and is merely undiscoverable or unenforced.
- Confirm that the lesson applies beyond the exact line or incident that exposed it.
- Distinguish an intentional constraint from legacy code, coincidence, or a temporary workaround.
- Use review comments, issue context, failures, or repeated examples as evidence when available.

If evidence is weak or contradictory, record the uncertainty in the task report rather than inventing policy.

### 3. Classify the learning

Classify it as one or more of:

- **Invariant:** invalid states or inputs should be impossible or rejected.
- **Regression risk:** known behavior needs protection.
- **Pattern violation:** code can be recognized as acceptable or unacceptable.
- **Workflow requirement:** a repeatable command or sequence is required.
- **Repository convention:** contributors need guidance that is not fully machine-enforceable.
- **Architectural or domain rationale:** future changes require the reason behind a constraint.
- **One-off detail:** retain locally, or do not encode.

### 4. Choose the strongest practical layer

Prefer prevention and executable checks over prose. Use the highest suitable layer in this order, combining layers only when they serve different purposes:

1. Types, schemas, API boundaries, or configuration constraints
2. Lint rules, formatters, or static analysis
3. Focused unit, integration, regression, contract, or end-to-end tests
4. CI checks and validation scripts
5. Reusable helpers, generators, development tooling, or automated workflows
6. Repository agent instructions such as `AGENTS.md` or `CLAUDE.md`
7. Review guidance such as `REVIEW.md`, checklists, or pull-request templates
8. Architecture, contributor, operational, or domain documentation
9. Local code comments for non-obvious rationale tied to nearby code

Do not use a comment or document as the only safeguard when a reliable executable check is proportionate. Do not build expensive automation for a rare, low-impact condition when concise guidance is sufficient.

### 5. Make the smallest durable change

- Update the existing source of truth instead of creating a competing document.
- State what to do, when it applies, and why it matters.
- Keep guidance concrete enough for an unfamiliar contributor or agent to act on without private context.
- Link guidance to the relevant check, command, decision record, or canonical document when helpful.
- Encode the general rule while using the current incident only as evidence.
- Keep tests focused on observable behavior rather than reproducing implementation details.
- Avoid sweeping cleanup or unrelated policy changes.

When no suitable destination exists, select one consistent with the repository's existing organization. Do not introduce new top-level instruction or review files casually.

### 6. Verify the safeguard

Verify in proportion to the change:

- Demonstrate that a new automated check fails for the relevant bad case and passes for the corrected case when practical.
- Run the affected tests, lint rules, type checks, validation scripts, or documentation checks.
- Re-read modified guidance alongside nearby instructions to detect contradictions and duplication.
- Check that the rule does not reject legitimate variants or overfit the triggering incident.
- Confirm that paths, commands, and examples are accurate.

If verification cannot be completed, say exactly what remains unverified.

### 7. Report the result

At handoff, briefly state:

- The durable lesson, if any
- Where it was encoded and why that layer was chosen
- What future failure or friction it should prevent
- How it was verified
- Any candidate learning deliberately not encoded because it was one-off, uncertain, duplicative, disproportionate, or outside scope

Keep this report subordinate to the primary task outcome. If nothing qualified, say so only when the skill was explicitly requested or the result is otherwise useful.

## Apply Guardrails

- Do not turn personal preference into repository policy.
- Do not infer a universal rule from a single unexplained example.
- Do not copy the same instruction into several files for visibility; improve discovery from one canonical source.
- Do not preserve secrets, personal data, transient logs, or incident-specific sensitive details in durable guidance.
- Do not weaken an existing check merely to accommodate the current implementation.
- Do not add brittle checks whose maintenance cost exceeds the recurring problem.
- Do not claim a class of issue is prevented when the safeguard covers only one example.
- Do not update generated or vendored files when their source can be updated instead.

## Use Common Mappings

| Discovery                                            | Prefer                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| Input or state must be valid                         | Type, schema, boundary validation, and focused tests              |
| A forbidden or required code pattern is recognizable | Lint rule or static analysis                                      |
| Behavior could regress                               | Regression test at the lowest effective level                     |
| Every change must perform a mechanical check         | CI validation                                                     |
| Contributors repeat a fragile sequence               | Script, task, generator, or workflow automation                   |
| Framework or architecture choice requires judgment   | Agent instructions plus review guidance                           |
| Setup or operational step is hard to discover        | Automation plus canonical contributor or operations documentation |
| Local code has a surprising reason                   | Test where possible, plus a concise rationale comment             |
| Reviewer repeatedly supplies the same context        | Enforce it mechanically; otherwise update canonical instructions  |

## Revisit Repeated Guidance

When the same prose rule is violated repeatedly, treat that as evidence that documentation alone is insufficient. Look for a stronger constraint, check, template, or workflow. When an automated safeguard repeatedly produces false positives or requires exceptions, revisit whether the encoded rule is too broad.
