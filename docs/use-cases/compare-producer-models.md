# Compare Producer Models

Use this workflow when you want to know whether different producer models need the same skill guidance.

For example, a stronger producer model might pass the no-skill baseline while a cheaper producer model needs a skill to reach the same `target_score`.

## When To Use This

Use producer model comparison when:

- You are choosing between model quality and cost.
- You want to know whether a skill makes a smaller model viable.
- You want separate baselines for each producer model.
- You are checking whether a model upgrade reduces the need for domain guidance.

## Suggested Setup

Keep the eval cases, rubric, input, reference material, judge model, and `target_score` stable across runs. Change only `models.producer` in `config.json` or run against separate project copies with different producer settings.

This makes the comparison easier to interpret.

## Step 1: Run A No-Skill Baseline Per Producer

For each producer model, generate a baseline:

```bash
varlock run -- pnpm exec flue run autoresearch --target node --root . --id baseline-haiku --payload '{"projectRoot":"path/to/my-autoresearch-project","runResearch":false,"sessionId":"baseline-haiku"}'
```

Record:

- producer model name,
- `overall.normalizedScore`,
- notable score rationales,
- approximate cost and latency, if available.

## Step 2: Compare Against Target

If a producer reaches `target_score` without a skill, that model may not need additional guidance for the current eval set.

If a producer falls short, run seed skill improvement for that model and compare the post-skill score against its baseline.

## Step 3: Keep Artifacts Separate

Baseline score writes use exclusive file creation. To avoid collisions, use separate project workspaces, clean generated artifacts between runs, or use a copied project root per producer comparison.

Do not commit generated model transcripts if they contain secrets or sensitive data.

## Interpretation Notes

A lower no-skill baseline does not automatically mean the model is unsuitable. A good skill may close the gap enough to make a cheaper model the better operational choice.

A high no-skill baseline does not prove the model is robust outside the eval set. Add evals before making a broad claim.
