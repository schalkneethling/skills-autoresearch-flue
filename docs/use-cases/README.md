# Harness Use Cases

Use-case docs explain why you would run the harness a certain way, then point to the commands and artifacts that support that workflow.

The general operating guide is still [Using the Harness](../using-the-harness.md). Start there when you need the project layout, config shape, payload fields, or a full alpha run walkthrough.

## Available Use Cases

- [No-Skill Baseline Guidance Check](no-skill-baseline-guidance-check.md): determine whether a producer model can solve the domain task without any skill guidance.
- [Seed Skill Improvement](seed-skill-improvement.md): improve an existing seed skill through the standard autoresearch loop.
- [Compare Producer Models](compare-producer-models.md): run the same evals with different producer models to compare the need for skill guidance, cost, and output quality.
- [Regression Test An Existing Skill](regression-test-existing-skill.md): use repeatable evals to check whether a known skill still performs as expected.

## Choosing A Use Case

Start with the no-skill baseline guidance check when you do not yet know whether the model needs a skill. If the baseline already reaches `target_score`, the model may be good enough for that eval set without extra domain guidance.

Use seed skill improvement when you already have a skill and want the researcher to patch it based on score feedback.

Use producer model comparison when model choice is part of the question. The same skill may be unnecessary for a stronger producer model and valuable for a smaller or cheaper one.

Use regression testing when you care less about discovering new guidance and more about preserving known behavior across skill edits, model changes, or harness changes.
