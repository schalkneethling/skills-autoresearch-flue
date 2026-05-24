# Agent Guide

This repository is an alpha Flue-based harness for autoresearching agent skills. It evaluates a seed skill against repeatable fixtures, asks a researcher model to improve the skill, then reruns evals against the candidate skill and persists enough artifacts to audit what happened.

Keep this file short. Use it as orientation before reading deeper docs.

## Start Here

- User-facing harness guide: `docs/using-the-harness.md`
- Contributor guide: `CONTRIBUTING.md`
- Alpha run workflow: `docs/alpha-run.md`
- Working fixture: `fixtures/projects/release-notes-alpha/`
- Packaged skill: `skill/skills-autoresearch/SKILL.md`

## Current Shape

- Language/runtime: TypeScript ESM, Node `>=24`, pnpm.
- Flue is the preferred alpha harness path; the CLI still exists but overlaps with the Flue entrypoint.
- Models are split by responsibility:
  - Researcher improves the candidate skill.
  - Producer runs the target skill and writes eval outputs.
  - Judge scores only the producer output.
- Current committed config is Anthropic-focused and expects secrets through Varlock/1Password.

## Key Code Paths

- `.flue/agents/autoresearch.ts`: Flue agent entrypoint.
- `.flue/roles/`: Flue roles for researcher, producer, and judge.
- `src/orchestrator.ts`: baseline import/generation and research iteration loop.
- `src/flue-harness.ts`: Flue session adapters and structured-result calls.
- `src/model-agent.ts`: prompt builders, model response schemas, and artifact application.
- `src/runner.ts`: eval execution and concurrency helper.
- `src/schemas.ts`: Valibot schemas and public data contracts.
- `src/project.ts`: project config and input loading.
- `tests/`: unit, integration, and dry-run coverage.

## Useful Commands

```bash
pnpm test
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm run build
pnpm run flue:build
pnpm run alpha:smoke
```

Model-backed research requires credentials:

```bash
pnpm run env:check
pnpm run alpha:research
```

`alpha:smoke` imports the committed baseline and should not call a model.

## Project Fixture Layout

Autoresearch project roots generally contain:

```text
config.json
evals/eval-cases.json
evals/rubric.md
input/
reference/
seed-skill/SKILL.md
workspace/baseline/
```

Generated research output lands under `workspace/iterations/<n>/`. Do not commit generated iterations unless the test or documentation intentionally needs a recorded run.

## Guardrails

- Keep Flue as the primary harness layer for alpha work.
- Do not collapse producer and judge into one self-scoring model call.
- Prefer schema-validated structured model output over ad hoc parsing.
- Preserve auditability: output files, score JSON, summaries, and transcripts matter.
- Keep fixtures small and deterministic.
- Update docs and tests when config shape, artifact layout, commands, or model flow changes.
- Never commit `.env`, resolved API keys, provider secrets, or transcripts containing secrets.
- Score and summary writes often use exclusive file creation; rerun failures may indicate existing artifacts rather than logic failure.

## What Is Still Alpha

- Only Anthropic is supported by the committed model client/config.
- Cross-provider judging is planned but not implemented.
- Resume/retry behavior is basic.
- The main fixture has one eval case and one track.
- Multi-skill projects are documented conceptually, but the current alpha run improves one seed skill per invocation.

## Testing Pointers

- `tests/flue-harness.test.ts`: Flue adapter behavior and structured prompts.
- `tests/e2e-dry-run.test.ts`: end-to-end orchestration with queued model responses.
- `tests/model-agent.test.ts`: prompt builders, parsing, artifact writes, model client behavior.
- `tests/sandbox-runner-orchestrator.test.ts`: sandbox, runner, and iteration loop behavior.
- `tests/baseline-aggregate-score.test.ts`: baseline import, aggregation, and score parsing.

For behavior changes, add focused tests at the lowest useful level. For cross-boundary changes, add or update a dry-run/integration test.
