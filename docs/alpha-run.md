# Alpha Run

The model-backed alpha run uses Varlock to inject provider credentials into the Flue harness without storing secrets in the repo.

The current alpha harness is Flue-first:

- `.flue/agents/autoresearch.ts` is the runnable Flue agent.
- `.flue/roles/` defines the model roles.
- `src/flue-harness.ts` adapts Flue `session.prompt(..., { result })` calls into the autoresearch loop.
- `fixtures/projects/release-notes-alpha/` is the committed alpha fixture.

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

This runs the Flue agent with:

```json
{
  "projectRoot": "fixtures/projects/release-notes-alpha",
  "withBaseline": true,
  "runResearch": true,
  "seedSkillDir": "fixtures/projects/release-notes-alpha/seed-skill",
  "sessionId": "alpha-research"
}
```

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
