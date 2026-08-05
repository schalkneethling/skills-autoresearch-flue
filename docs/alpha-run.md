# Alpha Run

The model-backed alpha run uses Varlock to inject provider credentials into the Flue harness without storing secrets in the repo.

The current alpha harness is Flue-first:

- `src/flue-agents.ts` defines addressable producer, judge, researcher, and determinizer agents for Flue 2.0.3.
- `src/flue-runtime.ts` owns the application-level `start()`/`init()`/`dispatch()`/`read()` boundary.
- `src/flue-harness.ts` adapts role dispatch into the autoresearch loop, and `src/flue-runner.ts` owns CLI lifecycle.
- `fixtures/projects/release-notes-alpha/` is the committed alpha fixture.

Role Markdown files are application-level configured labels and prompt context; they do not register Flue agents. Project-local roles may live in either supported directory; discovery combines both locations, removes duplicates, and sorts the role names:

```text
roles/
  custom-producer.md
.flue/roles/
  eval-judge.md
  skill-builder.md
  task-producer.md
```

## 1Password Setup

Create a 1Password item with:

- Vault: `dev`
- Item: `anthropic`
- Field: `api_key`

The committed `.env.schema` resolves:

```dotenv
ANTHROPIC_API_KEY=op(op://dev/anthropic/api_key)
```

For local development, Varlock is configured to use the 1Password desktop app / CLI integration with `allowAppAuth=true`.

## Validate Environment

```bash
pnpm run env:check
```

If this reports that the `dev` vault is unavailable, check the active 1Password CLI account:

```bash
op whoami
```

Then sign in to the account that has access to the `dev` vault.

## Run Baseline Smoke

This does not require model credentials.

```bash
pnpm run alpha:smoke
```

## Run Model-Backed Research

This requires `ANTHROPIC_API_KEY` to resolve through Varlock.

```bash
pnpm run alpha:research
```

## Run The Read-Only Determinization Fixture

The committed response fixture makes the complete report reproducible without credentials or a model call:

```bash
pnpm run alpha:determinize
```

Inspect the generated report at:

```text
fixtures/projects/release-notes-alpha/workspace/determinization/report.md
```

The command also prints that absolute path plus opportunity and deterministic-asset counts. The fixture intentionally classifies “Keep the output concise” as partially deterministic: text metrics and LanguageTool capability families may contribute, a custom LanguageTool rule may be worth later investigation, and editorial judgment remains necessary.

All reported assets are suggested and unverified. This run does not establish that a LanguageTool rule exists or is configured, and it does not propose, verify, apply, or adopt anything. The fixture skill and repository catalog remain read-only.

For a live Flue-backed analysis with Anthropic credentials, build and run:

```bash
pnpm run build
varlock run -- node dist/src/flue-runner.js determinize \
  --project fixtures/projects/release-notes-alpha
```

Determinization resume is available only through the direct `determinize report` CLI, not the Flue-backed `determinize` command. It validates current inputs and re-renders the existing immutable `opportunities.json` without another model call:

```bash
node dist/src/cli.js determinize report \
  --project fixtures/projects/release-notes-alpha \
  --resume
```

Normal runs print compact phase/eval progress and write application events, results, and errors under `fixtures/projects/release-notes-alpha/workspace/run-logs/`. Add `-- --verbose` to `alpha:smoke` or `alpha:research` to print debug application events and the structured result, or `-- --no-run-log` to disable the local audit log. Run logs intentionally omit Flue's full prompt and tool stream because `turn_request` events contain complete prompts and tools.

This runs the application-owned Flue 2 runtime with:

```json
{
  "projectRoot": "fixtures/projects/release-notes-alpha",
  "withBaseline": true,
  "runResearch": true,
  "sessionId": "alpha-research"
}
```

The wrapper derives the baseline/research flags from the `research` command, and the fixture's `origin_skill` config selects `seed-skill`.

If the imported baseline already meets `target_score`, the run emits `baseline-target-score-reached` and stops before creating `workspace/iterations/1`. Add `--force-research` only when you want to spend model calls on research anyway.

During research, an iteration that reaches the aggregate target but lowers any eval case below its baseline score emits `target-score-blocked-by-regression` and continues until a non-regressing candidate reaches the target or `max_iterations` is exhausted.

## Resume An Interrupted Run

If a model-backed run stops after writing some artifacts, rerun the config-driven command with `--resume`:

```bash
varlock run -- pnpm run autoresearch -- research --project fixtures/projects/release-notes-alpha --resume
```

Resume validates and reuses completed scores, candidate research, producer output, and judge transcripts, then runs only missing phases. It rebuilds a missing iteration summary after all scores are present. Incomplete research or producer artifacts that are safe to retry are moved to `workspace/resume-backups/`; invalid or inconsistent artifacts stop the run with an actionable error rather than being overwritten.

Use resume only when project config, evals, inputs, reference material, models, and the seed skill are unchanged from the interrupted run. The resumed invocation's cost summary covers calls made during that invocation, not calls from earlier failed attempts.

## Model Split

The alpha fixture config assigns different models per phase:

```json
{
  "models": {
    "producer": {
      "provider": "anthropic",
      "name": "claude-haiku-4-5"
    },
    "judge": {
      "provider": "anthropic",
      "name": "claude-sonnet-4-6"
    },
    "researcher": {
      "provider": "anthropic",
      "name": "claude-sonnet-4-6"
    }
  }
}
```

The producer writes eval outputs only. The judge reads those outputs and returns the score. This reduces self-grading bias and gives us a clean path to cross-provider evaluation later.

All four agents use schema-backed submit tools, and the runtime accepts exactly one validated result on the expected role channel. They deliberately declare no sandbox: the application serializes bounded selected inputs into prompts and alone applies validated outputs. Flue usage and cost are attached through response-finish metadata and included in the current accounting.

When started, the runtime is process-local, uses in-memory persistence, and is always stopped in `finally`. Beta persisted conversation state was not migrated. Existing application artifact resume remains available; durable Flue submissions and runtime-level recovery are a later phase.

## Expected Artifacts

After a successful `alpha:research` run, inspect:

```text
fixtures/projects/release-notes-alpha/workspace/iterations/1/
  skill/SKILL.md
  skill/references/...       # when the researcher adds stable detail
  skill/scripts/...          # when deterministic logic is useful
  skill/assets/...           # when reusable output material is useful
  skill/RESEARCH.md
  skill/.autoresearch-flue-transcript.json
  outputs/notes-001/RESULT.md
  outputs/notes-001/producer-flue-transcript.json
  outputs/notes-001/judge-flue-transcript.json
  scores-0.json
  summary.json
```

Useful checks:

- Researcher transcript should show `anthropic/claude-sonnet-4-6`.
- Producer transcript should show `anthropic/claude-haiku-4-5`.
- Judge transcript should show `anthropic/claude-sonnet-4-6`.
- Producer output should contain only the concrete eval result.
- Judge score should be grounded in the producer output, not the skill instructions.
- `RESEARCH.md` should explain each changed file's resource placement and report focused validation for changed scripts, or say why validation was skipped.
- Transcripts should not contain secret markers such as `ANTHROPIC_API_KEY`, `api_key`, or provider key prefixes.

## Latest Alpha Result

The latest successful split-model run completed one iteration and reached the target:

```json
{
  "completedIterations": 1,
  "normalizedScore": 1,
  "events": [
    "project-loaded",
    "baseline-imported",
    "aggregated",
    "research-loop-ready",
    "iteration-started",
    "iteration-generated",
    "iteration-scored",
    "target-score-reached"
  ]
}
```
