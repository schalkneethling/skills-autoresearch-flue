# skills-autoresearch-flue

An alpha skills autoresearch harness built on [Flue](https://flueframework.com/).

The harness evaluates a seed skill against project fixtures, asks a researcher model to improve the skill, then reruns evals against the candidate skill. It is currently focused on validating whether Flue's agent harness primitives help build a reliable, auditable skills autoresearch loop.

## Current Architecture

- **Flue 2 agents:** `src/flue-agents.ts`
- **Application-owned Flue runtime:** `src/flue-runtime.ts`
- **Core orchestration:** `src/orchestrator.ts`
- **Flue adapters:** `src/flue-harness.ts`
- **CLI lifecycle:** `src/flue-runner.ts`
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
pnpm run autoresearch -- smoke --project path/to/project
varlock run -- pnpm run autoresearch -- research --project path/to/project
node dist/src/cli.js determinize report --project path/to/project --response-file path/to/analysis-response.json
pnpm run alpha:smoke
pnpm run alpha:research
pnpm run alpha:determinize
```

The `smoke`, `research`, and `determinize` commands derive normal payload fields and the session name, use project configuration, and avoid inline JSON. The application CLI also accepts `--payload` for advanced debugging; Flue 2 is started, addressed, and stopped inside the process rather than through `flue run`.

`alpha:smoke` imports a committed baseline and does not call a model.

`alpha:research` runs the model-backed Flue harness through `varlock run`.

Flue-backed commands are quiet by default and write append-only application events, results, and errors under the target project's `workspace/run-logs/`. Pass `-- --verbose` to print debug application events and the structured result, or `-- --no-run-log` to opt out. These logs intentionally exclude Flue's full prompt and tool stream.

`determinize report` performs read-only analysis and writes an inspectable report plus its canonical opportunity data under `workspace/determinization/`. Use a recorded `--response-file` for a credential-free deterministic run, or run through Varlock for a direct Anthropic model call. The analysis only suggests unverified deterministic assets: it does not propose, verify, apply, or adopt them, and it never modifies the selected skill, external context, or repository-owned asset catalog.

## Using The Harness

If you want to point the harness at your own skill, start with [docs/using-the-harness.md](docs/using-the-harness.md). It explains the required project layout, config fields, eval cases, baseline artifacts, run commands, and how to inspect results.

## Contributing

If you want to work on the harness itself, read [CONTRIBUTING.md](CONTRIBUTING.md). It explains the project structure, Flue integration, data contracts, fixtures, test expectations, and alpha limitations.

## Acknowledgements

This project was originally inspired by Andrej Karpathy's
[`autoresearch`](https://github.com/karpathy/autoresearch) and its compact loop
for autonomous, auditable research iterations. The skill-specific harness design
is also influenced by skill-creation guidance from OpenAI Codex's
[`skill-creator`](https://github.com/openai/skills/blob/main/skills/.system/skill-creator/SKILL.md)
and Anthropic's open-source
[`skill-creator`](https://github.com/anthropics/skills/blob/main/skills/skill-creator/SKILL.md).
The ideas adopted here are conceptual: progressive disclosure for skill context,
trigger-focused metadata, candidate skill review, baseline comparison, repeatable
eval fixtures, and iterative review loops.

No source text or implementation from those projects is intentionally copied into
this repository. If future work closely adapts code, templates, prompts, or other
copyrightable material from the Anthropic skill-creator, preserve its
[`Apache-2.0` license notice](https://github.com/anthropics/skills/blob/main/skills/skill-creator/LICENSE.txt)
and document the adapted files here or in a project notice file.

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
