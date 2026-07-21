# Contributing

This project is an alpha Flue agent harness for autoresearching and evaluating agent skills. Contributors may also be users of the harness, but this document focuses on how the repository is structured and how to change it safely.

For user-facing setup and running your own skill through the harness, start with [docs/using-the-harness.md](docs/using-the-harness.md).

## Project Goals

The project is testing how much [Flue](https://flueframework.com/) can help us build a reliable skills autoresearch harness.

The harness should:

- Evaluate a seed skill against repeatable project fixtures.
- Improve the skill through a researcher model.
- Produce eval outputs with a separate producer model.
- Score those outputs with a separate judge model.
- Persist enough artifacts to audit every iteration.
- Keep credentials out of repo files, prompts, transcripts, and model-visible context.

## Repository Map

```text
.flue/
  workflows/autoresearch.ts   Flue workflow entrypoint.
  profiles.ts                 Named producer, judge, and researcher subagent profiles.
docs/
  alpha-run.md                Alpha run and credential workflow.
  using-the-harness.md        User guide for running custom skill projects.
fixtures/
  baseline/                   Imported legacy baseline fixture data.
  projects/release-notes-alpha/
                              Committed alpha project fixture.
src/
  orchestrator.ts             Baseline and research iteration loop.
  flue-harness.ts             Flue session adapters for producer/judge/researcher.
  model-agent.ts              Prompt builders, schemas, artifact application helpers.
  runner.ts                   Eval runner and concurrency helper.
  sandbox.ts                  Local readonly/write sandbox abstraction.
  schemas.ts                  Valibot schemas and public data contracts.
  baseline.ts                 Imported baseline artifact parsing.
  aggregate.ts                Score aggregation.
tests/
  *.test.ts                   Unit, integration, and dry-run coverage.
```

## Flue Integration

Flue is not incidental here; it is the harness layer.

The runnable workflow is:

```text
.flue/workflows/autoresearch.ts
```

It initializes Flue with a local sandbox and calls `runFlueAutoresearch()`.

The Flue adapter is:

```text
src/flue-harness.ts
```

It uses `session.task(..., { agent, result })` so Flue runs the named subagent profile and performs structured-output validation before the harness writes artifacts or scores.

## Research Flow

The model-backed path is intentionally split:

1. **Researcher** (`researcher`, Sonnet): patches the candidate skill.
2. **Producer** (`producer`, Haiku): runs the candidate skill and writes `output_files`.
3. **Judge** (`judge`, Sonnet): scores only producer output.

This is important. Avoid collapsing producer and judge back into a single self-scoring call.

The current artifact layout for an iteration is:

```text
workspace/iterations/<n>/
  skill/
    SKILL.md
    RESEARCH.md
    .autoresearch-flue-transcript.json
  outputs/<eval-id>/
    RESULT.md
    producer-flue-transcript.json
    judge-flue-transcript.json
  scores-0.json
  summary.json
```

Generated `workspace/iterations/` output should not be committed for normal fixtures unless the fixture is intentionally recording a specific run.

## Data Contracts

Schemas live in `src/schemas.ts`.

Important contracts:

- `ProjectConfigSchema`
- `EvalCasesFileSchema`
- `EvalScoreSchema`
- `ModelProduceResponseSchema`
- `SkillResearchPatchSchema`

When changing a schema:

- Update fixture files if needed.
- Update prompt examples in `src/model-agent.ts`.
- Update docs if user-facing config changes.
- Add or update tests that parse and validate the new shape.

## Fixtures

The alpha project fixture is:

```text
fixtures/projects/release-notes-alpha/
```

Keep it small and focused. It should stay baseline-only by default:

```text
workspace/baseline/
```

Do not leave generated `workspace/iterations/` artifacts in the fixture unless there is a deliberate test or documentation reason.

## Credentials And Secrets

Secrets are loaded through Varlock and 1Password.

Committed config:

```text
.env.schema
```

Expected secret reference:

```dotenv
ANTHROPIC_API_KEY=op(op://dev/anthropic/api_key)
```

Do not commit:

- `.env`
- resolved API keys
- copied provider keys
- transcripts containing secrets

Before sharing run artifacts, check transcripts for obvious secret markers.

## Development Workflow

Install dependencies:

```bash
pnpm install
```

CI installs from the committed lockfile and runs the complete model-free verification path. To reproduce that path from
a clean checkout, install with:

```bash
pnpm install --frozen-lockfile
```

Then run the same ordered verification command as CI:

```bash
pnpm run check
```

The `check` script is the single source of truth for the verification order. Its final `alpha:smoke` command imports the
committed baseline without calling a model or requiring provider credentials, so the full path is safe to run in public
CI.

Run the model-backed alpha flow:

```bash
pnpm run env:check
pnpm run alpha:research
```

`alpha:research` requires the 1Password item documented in [docs/alpha-run.md](docs/alpha-run.md).

## Testing Expectations

Prefer focused tests for every behavior change.

Useful existing test files:

- `tests/flue-harness.test.ts`: Flue adapter behavior and structured prompts.
- `tests/e2e-dry-run.test.ts`: end-to-end orchestration with queued model responses.
- `tests/model-agent.test.ts`: prompt builders, parsing, artifact writes, model client behavior.
- `tests/sandbox-runner-orchestrator.test.ts`: sandbox, runner, and iteration loop behavior.
- `tests/baseline-aggregate-score.test.ts`: baseline import, aggregation, and score parsing.

When adding a feature, include at least one test at the lowest useful level. For cross-boundary changes, add an integration or dry-run test as well.

## Linting And Formatting

Formatting is Prettier.

```bash
pnpm run format
pnpm run format:check
```

Linting is ESLint with TypeScript support.

```bash
pnpm run lint
```

Run these before pushing.

## Working With Generated Artifacts

The harness writes many files under `workspace/`.

For repeatable fixture runs, start the run with cleanup enabled:

```bash
pnpm exec skills-autoresearch --project fixtures/projects/release-notes-alpha --with-baseline --research --with-cleanup --score-dir path/to/scores
```

`--with-cleanup` removes generated iterations, resume backups, and the guidance ledger before the run while preserving the baseline and project inputs. Score files and summaries otherwise keep their conservative exclusive-write behavior.

## Contribution Guidelines

- Keep Flue as the primary harness layer.
- Keep producer and judge separated.
- Prefer schema-validated model outputs.
- Preserve auditability through transcripts and output files.
- Keep fixtures small and deterministic.
- Update docs when behavior, config, commands, or artifact layout changes.
- Do not commit secrets or generated build output.

## Current Alpha Limitations

- Only Anthropic is supported in the committed config.
- Cross-provider judging is planned but not implemented.
- Resume/retry behavior is still basic.
- The alpha fixture has one eval case and one track.
- The CLI and Flue entrypoint overlap; Flue is the preferred harness path for alpha testing.
