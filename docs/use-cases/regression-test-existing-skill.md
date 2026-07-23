# Regression Test An Existing Skill

Use this workflow when you want repeatable evidence that a known skill still behaves as expected.

This is useful after editing a skill, changing roles, upgrading models, or changing harness behavior.

## When To Use This

Use regression testing when:

- You have a skill that already passes its evals.
- You want to verify that a change did not reduce score.
- You want a small deterministic fixture for review.
- You want to compare candidate output against a committed baseline.

## Step 1: Keep A Baseline

Commit only intentional baseline fixtures. A baseline should include:

```text
workspace/baseline/
  scores-0.json
  summary.json
  <eval-id>/
    task.md
    input/
    output/
```

The baseline can be imported without model calls:

```bash
pnpm run flue:run -- --payload '{"projectRoot":"path/to/my-autoresearch-project","withBaseline":true,"runResearch":false,"sessionId":"regression-smoke"}'
```

This validates the project and imported score artifacts.

## Step 2: Run A Candidate Pass

To evaluate an updated seed skill through the normal research loop:

```bash
varlock run -- pnpm run flue:run -- --payload '{"projectRoot":"path/to/my-autoresearch-project","withBaseline":true,"runResearch":true,"seedSkillDir":"path/to/my-autoresearch-project/seed-skill","sessionId":"regression-research"}'
```

If the imported baseline already reaches `target_score`, the harness stops before research unless you set `forceResearch:true`.

Use `forceResearch:true` only when you intentionally want a fresh candidate despite a passing baseline.

## Step 3: Review The Difference

Compare:

- imported baseline `summary.json`,
- latest iteration `summary.json`,
- per-eval `scores-*.json`,
- producer outputs under `workspace/iterations/<n>/outputs/`,
- candidate skill changes under `workspace/iterations/<n>/skill/`.

## Cleanup

Generated iteration artifacts are written with exclusive file creation. Use cleanup mode to rerun the same project from a clean research slate:

```bash
pnpm exec skills-autoresearch --project path/to/my-autoresearch-project --with-baseline --with-cleanup --research --score-dir path/to/scores
```

Cleanup preserves the baseline and removes generated iterations, resume backups, and the guidance ledger. Only commit generated iterations when the fixture or documentation intentionally needs a recorded run.
