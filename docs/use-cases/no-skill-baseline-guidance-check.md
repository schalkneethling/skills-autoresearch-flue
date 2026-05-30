# No-Skill Baseline Guidance Check

Use this workflow to answer a product question before investing in skill authoring:

> Can this producer model already perform the domain task well enough without a skill?

The harness can do this today because generated baseline runs mount no target skill. The producer receives the role, eval case, input files, reference files, and rubric context, but no `/skill` files.

## When To Use This

Use a no-skill baseline when:

- You have evals for a domain task, but you are not sure whether skill guidance is needed.
- You want to compare a model's natural behavior against a target score.
- You want a clean before/after score before running autoresearch against a seed skill.
- You are deciding whether to spend time writing or improving a skill.

Do not use this as proof that a model never needs guidance. It only answers the question for the configured model, role, eval cases, rubric, and reference material.

## What This Shows

If the baseline reaches `target_score`, the model likely does not need additional skill guidance for this eval set.

If the baseline falls short, the scores and judge rationales help identify where domain guidance may help. You can then run the standard seed skill improvement workflow, or enable seed-as-reference research by setting `research_start` to `"empty"`.

## Project Setup

Create or reuse an autoresearch project with:

```text
my-autoresearch-project/
  config.json
  evals/
    eval-cases.json
    rubric.md
  input/
    ...
  reference/
    ...
  seed-skill/
    SKILL.md
  workspace/
```

The `seed-skill/` directory can exist even though the baseline will not mount it. The seed skill becomes relevant only if you continue into research.

## Step 1: Generate The Baseline

From the root of this harness checkout, run:

```bash
varlock run -- pnpm exec flue run autoresearch --target node --root . --id my-baseline --payload '{"projectRoot":"path/to/my-autoresearch-project","runResearch":false,"sessionId":"my-baseline"}'
```

Omit `withBaseline` so the harness generates a fresh model-backed baseline. Use `runResearch:false` so the run stops after baseline generation and aggregation.

Expected events include:

```text
baseline-started
baseline-generated
aggregated
research-loop-ready
```

Generated artifacts are written under:

```text
path/to/my-autoresearch-project/workspace/baseline/
```

## Step 2: Inspect The Score

Open:

```text
path/to/my-autoresearch-project/workspace/baseline/summary.json
```

Compare `overall.normalizedScore` with `target_score` from `config.json`.

Also inspect each `scores-*.json` file. Judge rationales often matter more than the aggregate number because they explain what guidance the model lacked.

## Step 3: Interpret The Result

If `overall.normalizedScore >= target_score`, the model reached the goal without a skill. You can treat this as evidence that the configured producer model does not need extra domain guidance for the current eval set.

If `overall.normalizedScore < target_score`, the model likely needs either:

- better role or eval context,
- better reference material,
- a domain skill,
- a stronger producer model, or
- a more focused rubric/eval set.

## Step 4: Optional Early-Exit Check

After generating the baseline, you can run with `withBaseline:true` and `runResearch:true` to confirm the harness will stop before research when the baseline already passes:

```bash
varlock run -- pnpm exec flue run autoresearch --target node --root . --id my-research-check --payload '{"projectRoot":"path/to/my-autoresearch-project","withBaseline":true,"runResearch":true,"seedSkillDir":"path/to/my-autoresearch-project/seed-skill","sessionId":"my-research-check"}'
```

When the baseline passes, the run emits:

```text
baseline-target-score-reached
```

and does not create `workspace/iterations/1`.

## Seed-As-Reference Research

To start research from an empty candidate skill while using the seed skill only as reference material, add this to `config.json`:

```json
{
  "origin_skill": "seed-skill",
  "research_start": "empty"
}
```

If `guidance_skill` is omitted, `origin_skill` is used as the immutable guidance skill. Iteration 1 starts from `workspace/empty-skill`; later iterations continue from the previous candidate skill.

Model-backed research writes `workspace/guidance-ledger.json` when the researcher records which seed/reference sections were used, deferred, ignored, or requested. After iteration 1, prompts include that ledger and a compact seed/reference index instead of the full seed skill content by default.
