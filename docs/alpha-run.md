# Alpha Run

The model-backed alpha run uses Varlock to inject provider credentials into the Flue harness without storing secrets in the repo.

The current alpha harness is Flue-first:

- `.flue/workflows/autoresearch.ts` is the runnable Flue workflow.
- `.flue/profiles.ts` defines the named producer, judge, and researcher subagent profiles.
- `src/flue-harness.ts` adapts Flue `session.task(..., { agent, result })` calls into the autoresearch loop.
- `fixtures/projects/release-notes-alpha/` is the committed alpha fixture.

Flue role artifacts are Markdown files named for the registered role. Project-local roles may live in either supported directory; discovery combines both locations, removes duplicates, and sorts the role names:

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

This runs the Flue workflow with:

```json
{
  "projectRoot": "fixtures/projects/release-notes-alpha",
  "withBaseline": true,
  "runResearch": true,
  "seedSkillDir": "fixtures/projects/release-notes-alpha/seed-skill",
  "sessionId": "alpha-research"
}
```

If the imported baseline already meets `target_score`, the run emits `baseline-target-score-reached` and stops before creating `workspace/iterations/1`. Add `"forceResearch": true` to the payload only when you want to spend model calls on research anyway.

During research, an iteration that reaches the aggregate target but lowers any eval case below its baseline score emits `target-score-blocked-by-regression` and continues until a non-regressing candidate reaches the target or `max_iterations` is exhausted.

## Resume An Interrupted Run

If a model-backed run stops after writing some artifacts, rerun with the same run-defining payload and add `"resume": true`. The `sessionId` may be changed to distinguish the resumed invocation, as in this example:

```bash
varlock run -- pnpm exec flue run autoresearch --target node --root . --payload '{"projectRoot":"fixtures/projects/release-notes-alpha","withBaseline":true,"runResearch":true,"resume":true,"seedSkillDir":"fixtures/projects/release-notes-alpha/seed-skill","sessionId":"alpha-research-resume"}'
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

## Expected Artifacts

After a successful `alpha:research` run, inspect:

```text
fixtures/projects/release-notes-alpha/workspace/iterations/1/
  skill/SKILL.md
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
