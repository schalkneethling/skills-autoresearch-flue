# Project Goal

## North Star

Build a small, auditable Flue-based autoresearch harness that helps maintainers decide when skill context is worth using, and what the smallest useful skill should contain.

In this project, autoresearch means a repeatable evidence loop: run evals and rubrics against chosen producer models, compare no-skill and skill-guided performance, inspect score feedback, and let a researcher agent propose the smallest useful change to the skill context when guidance is justified.

A producer model is the model that does the actual task work from the provided input, reference material, and optional skill context. In day-to-day use, this could be any coding-agent model a team wants to evaluate, such as a Claude, GPT, Gemini, or other model release.

## Who This Is For

This project is for engineers and teams who want to optimize how they use coding agents by measuring, against their own eval cases and rubrics, which skills are needed, which producer models need them, and how much guidance is worth carrying in context.

## Core Goals

1. Allow maintainers to determine whether any skill is needed by running deterministic eval cases and rubrics against the producer models they want to test.
2. Allow maintainers to stop after a no-skill baseline when the model already meets or exceeds `target_score`, without investing more time or context in skill guidance.
3. If a skill is needed, create, improve, or stress-test skill guidance so maintainers can choose between the whole skill, a narrower skill, or no skill.
4. Preserve auditability through intuitive fixture inputs, baseline artifacts, candidate skills, output files, score JSON, summaries, cost summaries, and Flue transcripts.
5. Support practical skill research workflows:
   - no-skill baseline checks,
   - seed-skill improvement,
   - seed-as-reference research,
   - regression testing existing skills against new producer models to decide whether a skill still improves performance, needs to be optimized, or should be removed.
6. Support recovering from interrupted or failed runs without losing the audit trail or forcing maintainers to restart successful work.
7. Prefer schema-validated structured data over ad hoc parsing for configs, model outputs, scores, and research patches.
8. Keep fixtures small enough that contributors can understand failures, rerun smoke checks, and review generated artifacts by hand.

## Success Looks Like

- Engineers leave a run confident that any skill they add back to a project will meaningfully improve output quality against their evals and rubrics, and that removing an unnecessary skill will not cause a quality regression.
- No-skill baseline runs can show when a model already meets `target_score` without adding a skill.
- A run must stop before research when an imported or generated baseline already reaches `target_score`.
- A candidate that reaches the aggregate target but regresses below baseline on an eval case must not be accepted as the final answer without making that regression explicit.
- Candidate skill outcomes are evidence-based: create a new skill, improve the existing skill, narrow it, or remove it when no extra context is justified.
- Interrupted or failed runs can be resumed or retried from the last trustworthy artifact without overwriting evidence from completed phases.
- Artifacts are clear enough that a maintainer can reconstruct what changed, what output was produced, how it was scored, which role did the work, and why the run stopped.

## Non-Goals

- This is not a general-purpose benchmark suite for all agents or all tasks.
- This should not treat more skill text as the default answer to a weak baseline; the right response may be better reference material, a different producer model, a narrower eval, a smaller skill, or no skill at all.
- This should not collapse research, production, and judging into one self-scoring model call.
- This should not optimize for large, opaque fixtures that are hard to inspect.
- This should not silently overwrite generated evidence; exclusive artifact writes are part of the audit model.
- This should not commit generated research iterations unless a test or document intentionally needs a recorded run.

## Principles and Constraints

- The harness is a TypeScript CLI built on the Flue agent framework; changes should preserve that architecture unless the project explicitly decides to replace it.
- Researcher, producer, and judge responsibilities must stay separate: the researcher changes skill guidance, the producer writes eval outputs, and the judge scores only those outputs.
- The harness should make costs and planned model calls visible before spending model-backed effort.
- Baselines, candidate outputs, score rationales, summaries, and transcripts are evidence, so their paths and schemas should remain reviewable and documented.
- Documentation, examples, tests, and schemas should stay aligned so maintainers are not guided by stale project behavior.
- Research patches should make the smallest effective skill change that addresses observed score gaps and should avoid overfitting to one fixture.
- Credentials are provided through Varlock and 1Password in the committed workflow; `.env`, resolved keys, and secret-bearing transcripts must not be committed.
- Node, TypeScript ESM, pnpm, Valibot schemas, and the current fixture layout are part of the working alpha shape.

## Current Focus

The current alpha is centered on `fixtures/projects/release-notes-alpha/`, a single-skill release-notes fixture with one eval case and an imported baseline. The committed workflow is designed to prove the end-to-end loop: load a project, import or generate a baseline, optionally research a candidate skill, run producer evals, score with an independent judge, aggregate results, and persist artifacts.

Near-term work should keep tightening reliability, auditability, and documentation around that loop before broadening the surface area.

The next milestone is a dependable single-skill research loop: a user can install the harness, run or import a baseline, complete or resume a model-backed iteration, understand the evidence, and rerun safely without hand-editing Flue payloads or deleting artifacts manually.

Cross-provider judging becomes active focus after the single-provider flow is stable enough to make comparisons meaningful.

## Open Questions

- How should resume and retry behavior preserve auditability while making failed model-backed runs less manual to recover?
- What is the right project shape for first-class multi-skill research beyond running one target skill per invocation?
