# skills-autoresearch-flue

An alpha skills autoresearch harness built on [Flue](https://flueframework.com/).

The harness evaluates a seed skill against project fixtures, asks a researcher model to improve the skill, then reruns evals against the candidate skill. It is currently focused on validating whether Flue's agent harness primitives help build a reliable, auditable skills autoresearch loop.

## Current Architecture

- **Flue agent entrypoint:** `.flue/agents/autoresearch.ts`
- **Flue roles:** `.flue/roles/`
- **Core orchestration:** `src/orchestrator.ts`
- **Flue adapters:** `src/flue-harness.ts`
- **Prompt and artifact helpers:** `src/model-agent.ts`
- **Alpha fixture:** `fixtures/projects/release-notes-alpha/`

The model-backed eval path is split into separate phases:

1. **Researcher** (`claude-sonnet-4-6`): improves the candidate skill.
2. **Producer** (`claude-haiku-4-5`): runs the target skill and writes eval output files.
3. **Judge** (`claude-sonnet-4-6`): scores only the producer output.

This avoids self-grading by the producer and lets smaller/larger models be assigned per responsibility.

## Credentials

Secrets are loaded through Varlock and 1Password. The committed `.env.schema` expects:

- Vault: `dev`
- Item: `anthropic`
- Field: `api_key`

Validate locally:

```bash
pnpm run env:check
```

## Commands

```bash
pnpm test
pnpm run typecheck
pnpm run build
pnpm run flue:build
pnpm run alpha:smoke
pnpm run alpha:research
```

`alpha:smoke` imports a committed baseline and does not call a model.

`alpha:research` runs the model-backed Flue harness through `varlock run`.

## Using The Harness

If you want to point the harness at your own skill, start with [docs/using-the-harness.md](docs/using-the-harness.md). It explains the required project layout, config fields, eval cases, baseline artifacts, run commands, and how to inspect results.

## Contributing

If you want to work on the harness itself, read [CONTRIBUTING.md](CONTRIBUTING.md). It explains the project structure, Flue integration, data contracts, fixtures, test expectations, and alpha limitations.

## Alpha Fixture

The release-notes fixture lives at:

```text
fixtures/projects/release-notes-alpha/
```

It includes a seed skill, eval case, input/reference files, and a baseline workspace. A successful research run writes iteration artifacts under:

```text
fixtures/projects/release-notes-alpha/workspace/iterations/1/
```

See [docs/alpha-run.md](docs/alpha-run.md) for the detailed alpha workflow and expected artifacts.
