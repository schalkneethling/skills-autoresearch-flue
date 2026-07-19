---
name: skills-autoresearch
description: Use when converting an existing agent skill project or scaffolding a new project to run through the skills-autoresearch Flue harness, including project layout, config.json, eval cases, rubric, seed skill, baseline artifacts, and run commands.
---

# Skills Autoresearch

Use this skill to prepare a project for the `skills-autoresearch` harness. The goal is to create a small, auditable autoresearch project that can evaluate a seed agent skill, let a researcher model improve it, run producer evals against the candidate skill, and have a separate judge model score only the producer output.

## Required Workflow

Follow these gates in order. Do not skip a gate, and do not tell the user the project is ready until the Final Validation Gate passes.

1. **Discovery Gate**: Locate the harness checkout, read the harness docs/example, inspect the target project, and check git state.
2. **Shape Gate**: Choose the single-skill or multi-skill project shape and create the required directories.
3. **Skill Gate**: Create or move a valid seed skill with frontmatter and enough instructions to run.
4. **Eval Gate**: Create `config.json`, `evals/eval-cases.json`, `evals/rubric.md`, input files, and reference files.
5. **Baseline Gate**: Either import/hand-author `workspace/baseline/` or explicitly prepare the generated-baseline run path.
6. **Final Validation Gate**: Validate files, paths, schemas, rubric wording, baseline state, and git status before handing off.

## Discovery Gate

1. Ask the user for the full path to the local `skills-autoresearch` checkout and read `README.md`, `docs/using-the-harness.md`, and the alpha fixture under `fixtures/projects/release-notes-alpha/`.
2. Inspect the project being converted before writing files. Identify the skill or workflow to improve, representative inputs, expected outputs, and any stable reference material.
3. Preserve user work. Check `git status --short` before editing. If there are uncommitted changes, notify the user and pause to ask whether they want to proceed, stash, commit, or switch branches before starting.
4. If appropriate, start a new feature branch.

## Shape Gate

For a single-skill project, create:

```text
project-root/
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
    baseline/
      ...
```

For a multi-skill project, keep shared config/evals/reference at the root and put target skills under `skills/`:

```text
project-root/
  config.json
  program.md
  evals/
    eval-cases.json
    rubric.md
  input/
    ...
  reference/
    ...
  skills/
    skill-one/
      SKILL.md
    skill-two/
      SKILL.md
  workspace/
    baseline/
      ...
```

The current alpha harness improves one seed skill per run. For multi-skill projects, run once per target skill and pass `seedSkillDir` in the Flue payload.

## Skill Gate

When scaffolding a new project:

1. Create the directories shown above.
2. Write a minimal valid seed `SKILL.md`. It must include YAML frontmatter with `name` and `description`, plus enough body guidance for a producer agent to attempt the target task.
3. Add one or two small eval cases with concrete inputs and expectations.
4. Add a direct rubric that describes high-quality output.
5. Decide whether to import an existing baseline or generate one as the first harness run before model-backed research.

A minimal seed skill can be intentionally imperfect, but it should be runnable as an agent skill:

```md
---
name: my-skill
description: Use when producing the target output for this autoresearch project.
---

# My Skill

Use the provided task input and reference material to produce the requested output.

Write the result in the format requested by the eval task.
```

When converting an existing project:

1. Move or copy the existing skill instructions into `seed-skill/SKILL.md` or `skills/<name>/SKILL.md`.
2. Put task inputs under `input/`.
3. Put stable background material, examples, API notes, policies, or domain facts under `reference/`.
4. Convert existing tests, examples, or acceptance criteria into `evals/eval-cases.json` and `evals/rubric.md`.
5. Import any known output as `workspace/baseline/`.
6. If there is no existing baseline, ask the user whether they want to:
   - Generate a baseline as the first `skills-autoresearch` harness run.
   - Create a small baseline by hand so the smoke run can validate loading and aggregation before spending model calls.

Preserve any bundled `references/`, `scripts/`, and `assets/` already present in the seed skill. Candidate iterations may add or update these resources when eval evidence justifies them. Inspect `RESEARCH.md` to confirm the researcher kept core workflow guidance in `SKILL.md`, moved stable detail or reusable material into the appropriate resource directory, and recorded validation for changed scripts.

## Eval Gate

## Write `config.json`

Use this as the starting point and adjust names, paths, target score, models, and tracks:

```json
{
  "skill_name": "my-skill",
  "topic_group": "my-topic",
  "origin_skill": "seed-skill",
  "target_score": 0.8,
  "max_iterations": 1,
  "max_concurrency": 1,
  "model": {
    "provider": "anthropic",
    "name": "claude-sonnet-4-6"
  },
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
  },
  "roles": {
    "judge": "eval-judge",
    "skill_builder": "skill-builder"
  },
  "tracks": [
    {
      "id": "main",
      "eval_type": "my-eval-type",
      "role": "task-producer",
      "target_skill": "my-skill",
      "requires_description": false
    }
  ]
}
```

Notes:

- `origin_skill` is relative to the autoresearch project root unless absolute.
- `models.producer` writes eval outputs.
- `models.judge` scores producer outputs.
- `models.researcher` patches the skill.
- `tracks[].eval_type` must match the eval cases.
- `tracks[].role` and `roles.judge` refer to Flue roles in the harness checkout under `.flue/roles/`.

## Write Eval Cases

Create `evals/eval-cases.json`:

```json
{
  "evals": [
    {
      "id": "case-001",
      "eval_type": "my-eval-type",
      "title": "Short human-readable title",
      "input": {
        "file": "INPUT.md"
      },
      "expectations": {
        "must_include": ["important requirement"]
      },
      "scoring_dimensions": [
        {
          "id": "correctness",
          "label": "Correct and useful output",
          "max_score": 1
        }
      ]
    }
  ]
}
```

Keep early evals small, concrete, and easy to inspect. Prefer one or two targeted cases over a broad suite.

## Write The Rubric

Create `evals/rubric.md` with direct scoring guidance. The rubric should explain quality criteria and scoring expectations, but it must not instruct the judge to return a legacy or custom JSON shape.

```md
# Rubric

A high-scoring answer:

- Satisfies the concrete user request.
- Uses the provided input and reference material accurately.
- Avoids unsupported claims.
- Produces the expected files or output format.
```

The judge should evaluate producer output against the eval case and rubric, not reward the candidate skill instructions directly.

The Flue harness expects judge output to match this `EvalScore` shape:

```json
{
  "eval_id": "case-001",
  "eval_type": "my-eval-type",
  "track_id": "main",
  "total_score": 0.5,
  "max_score": 1,
  "dimensions": [
    {
      "id": "correctness",
      "score": 0.5,
      "max_score": 1,
      "rationale": "Brief evidence-grounded rationale."
    }
  ],
  "summary": "Brief overall assessment."
}
```

When converting an existing project, remove stale rubric instructions that mention legacy fields such as `focus_dimensions`, `scores`, `composite_score`, `expectations_met`, `expectations_missed`, `additional_observations`, or any output example that does not match `EvalScore`.

## Baseline Gate

The project can start with an imported baseline or create one as an initial harness run. Do not assume `workspace/baseline/` already exists.

If the user wants to import or hand-author a baseline, create this shape:

```text
workspace/baseline/
  scores-0.json
  summary.json
  case-001/
    task.md
    input/
    output/
```

Each `scores-*.json` file should match:

```json
{
  "eval_id": "case-001",
  "eval_type": "my-eval-type",
  "track_id": "main",
  "total_score": 0.5,
  "max_score": 1,
  "dimensions": [
    {
      "id": "correctness",
      "score": 0.5,
      "max_score": 1,
      "rationale": "Baseline is partially correct but misses an important requirement."
    }
  ],
  "summary": "Baseline is usable but incomplete."
}
```

`summary.json` should aggregate the baseline scores. Use the alpha fixture as the concrete example if the schema is unclear.

If the user wants the harness to generate the baseline, run without `withBaseline` and with `runResearch:false`. This creates `workspace/baseline/` and does not count as a research iteration.

## Run From The Harness Checkout

Install and validate the harness:

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run build
```

Run a baseline smoke without model calls:

```bash
pnpm exec flue run autoresearch --target node --root . --id my-smoke --payload '{"projectRoot":"path/to/project-root","withBaseline":true,"runResearch":false,"sessionId":"my-smoke"}'
```

Expected smoke events should end with `research-loop-ready`.

To generate the initial baseline with the harness instead of importing one, validate credentials first:

```bash
pnpm run env:check
```

Then run without `withBaseline`:

```bash
varlock run -- pnpm exec flue run autoresearch --target node --root . --id my-baseline --payload '{"projectRoot":"path/to/project-root","runResearch":false,"sessionId":"my-baseline"}'
```

Expected generated-baseline events include `baseline-started` and `baseline-generated`.

For model-backed research after a baseline exists, run:

```bash
varlock run -- pnpm exec flue run autoresearch --target node --root . --id my-research --payload '{"projectRoot":"path/to/project-root","withBaseline":true,"runResearch":true,"seedSkillDir":"path/to/project-root/seed-skill","sessionId":"my-research"}'
```

For a multi-skill project, point `seedSkillDir` at the specific skill directory for this run, for example `path/to/project-root/skills/security-audit`.

## Final Validation Gate

Before reporting success, perform this validation and fix any failures.

1. Re-run `git status --short` in the target project and report the changed, deleted, and untracked paths. If unexpected deletions or moves appear, pause and ask the user before continuing.
2. Confirm these files exist:
   - `config.json`
   - `evals/eval-cases.json`
   - `evals/rubric.md`
   - `input/`
   - `reference/`
   - `seed-skill/SKILL.md` for single-skill projects, or the selected `skills/<name>/SKILL.md` for multi-skill projects
3. Validate `config.json` against the harness fields:
   - `skill_name`, `topic_group`, `target_score`, `max_iterations`, `max_concurrency`, `roles`, and at least one `tracks[]` entry are present.
   - Every `tracks[].eval_type` is used by at least one eval case.
   - `origin_skill` points to an existing skill directory unless the run will always pass `seedSkillDir`.
4. Validate `evals/eval-cases.json`:
   - The top-level object has an `evals` array.
   - Every eval has `id`, `eval_type`, `title`, and at least one `scoring_dimensions[]` entry.
   - Every `input.file` path resolves under `input/`.
   - Every eval's `eval_type` has a matching track in `config.json`.
5. Validate `evals/rubric.md`:
   - It references `scoring_dimensions`, not `focus_dimensions`.
   - It does not include legacy output examples using `scores`, `composite_score`, `expectations_met`, `expectations_missed`, or `additional_observations`.
   - Any output-shape example matches `EvalScore`: `eval_id`, `eval_type`, `track_id`, `total_score`, `max_score`, `dimensions`, and `summary`.
6. Validate the seed skill:
   - `SKILL.md` has YAML frontmatter with `name` and `description`.
   - The body gives enough task guidance for the producer to attempt the evals.
   - Supporting references are colocated with the skill or under project `reference/` and are mentioned where useful.
7. Validate baseline readiness:
   - If `workspace/baseline/` exists, confirm it has `summary.json`, at least one `scores-*.json`, and one directory per eval id with `task.md`, `input/`, and `output/`.
   - If `workspace/baseline/` does not exist, the next recommended command must be the generated-baseline command without `withBaseline` and with `runResearch:false`.
8. Run a schema/path validation command if the harness checkout is available. A direct Node check is enough; do not rely only on visual inspection.

## Inspect Results

After research, inspect artifacts under the autoresearch project root:

```text
workspace/iterations/1/
  skill/SKILL.md
  skill/RESEARCH.md
  skill/.autoresearch-flue-transcript.json
  outputs/<eval-id>/RESULT.md
  outputs/<eval-id>/producer-flue-transcript.json
  outputs/<eval-id>/judge-flue-transcript.json
  scores-0.json
  summary.json
```

Check that:

- The candidate `skill/SKILL.md` addresses observed baseline weaknesses without overfitting to one fixture.
- Producer output is a real answer to the eval task.
- Judge rationale cites producer output, not the skill instructions.
- Scores improved for the intended reasons.
- Transcripts do not leak secrets such as API keys or provider key prefixes.

## Reruns

Iteration artifacts are created with exclusive writes. To rerun from scratch, remove generated iterations in the autoresearch project:

```bash
rm -rf path/to/project-root/workspace/iterations
```

Do not remove baseline artifacts unless the user is intentionally replacing the baseline.
