# Seed Skill Improvement

Use this workflow when you already have a seed skill and want the harness to improve it through scored iterations.

The standard autoresearch loop is:

1. Import or generate a baseline.
2. Aggregate baseline scores.
3. Stop early if the baseline reaches `target_score`.
4. Ask the researcher to patch the seed skill when the baseline falls short.
5. Run producer evals against the candidate skill.
6. Ask the judge to score only the producer output.
7. Repeat until `target_score` is reached or `max_iterations` is exhausted.

## When To Use This

Use seed skill improvement when:

- You already have useful guidance in `seed-skill/SKILL.md`.
- You want the researcher to preserve and refine that skill.
- You want each candidate skill saved under `workspace/iterations/<n>/skill/`.
- You want audit artifacts for outputs, scores, summaries, and transcripts.

## Step 1: Prepare A Baseline

If `workspace/baseline/` already exists, you can import it:

```bash
pnpm exec flue run autoresearch --target node --root . --id my-smoke --payload '{"projectRoot":"path/to/my-autoresearch-project","withBaseline":true,"runResearch":false,"sessionId":"my-smoke"}'
```

If no baseline exists yet, generate one:

```bash
varlock run -- pnpm exec flue run autoresearch --target node --root . --id my-baseline --payload '{"projectRoot":"path/to/my-autoresearch-project","runResearch":false,"sessionId":"my-baseline"}'
```

## Step 2: Run Research

```bash
varlock run -- pnpm exec flue run autoresearch --target node --root . --id my-research --payload '{"projectRoot":"path/to/my-autoresearch-project","withBaseline":true,"runResearch":true,"seedSkillDir":"path/to/my-autoresearch-project/seed-skill","sessionId":"my-research"}'
```

If the imported baseline already reaches `target_score`, the run stops with `baseline-target-score-reached`.

If research proceeds, iteration artifacts land under:

```text
path/to/my-autoresearch-project/workspace/iterations/1/
  outputs/
  skill/
    SKILL.md
    RESEARCH.md
    .autoresearch-transcript.json
  scores-0.json
  summary.json
```

## Step 3: Inspect The Candidate

Review:

- `skill/SKILL.md`: the candidate skill produced by the researcher.
- `skill/RESEARCH.md`: the researcher's summary of intended changes.
- `summary.json`: aggregate score for the iteration.
- `scores-*.json`: judge scores and rationales for each eval.
- `outputs/<eval-id>/`: producer output and transcripts.

## Current Behavior

Iteration 1 starts by copying the seed skill and applying the researcher's patch. Later iterations start from the previous candidate skill.

If you need a workflow where iteration 1 starts from an empty skill and the seed is only reference material, follow [issue #40](https://github.com/schalkneethling/skills-autoresearch-flue/issues/40).
