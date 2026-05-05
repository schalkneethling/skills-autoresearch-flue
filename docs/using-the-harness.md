# Using the Harness

This guide is for someone who has an agent skill and wants to use this repository to improve it through autoresearch.

The current alpha flow is:

1. Define a small autoresearch project for your skill.
2. Provide eval inputs, expectations, and a scoring rubric.
3. Establish or import a baseline.
4. Run the Flue autoresearch agent.
5. Inspect the candidate skill and eval artifacts.

## What the Harness Does

For each research iteration, the harness runs three Flue-backed phases:

1. **Researcher**: reads baseline/previous scores and proposes a patched skill.
2. **Producer**: runs the candidate skill against eval input and writes output files.
3. **Judge**: scores only the producer output against the eval case and rubric.

The default alpha fixture uses:

- Researcher: `anthropic/claude-sonnet-4-6`
- Producer: `anthropic/claude-haiku-4-5`
- Judge: `anthropic/claude-sonnet-4-6`

## Project Root

When this guide says "project layout", it means an autoresearch project root: a repository or directory that contains the config, evals, reference material, candidate skill files, and workspace artifacts for one bounded improvement effort.

For example, a dedicated repository such as [`skills-autoresearch-security/`](https://github.com/schalkneethling/skills-autoresearch-security/tree/main) is a project root. The harness does not require the project root to live inside this repository; the `projectRoot` payload value points Flue at the project you want to run.

## Terminology

- **Project root**: the repository or directory that contains the autoresearch project files for one improvement effort.
- **Seed skill**: the starting skill that the researcher reads and improves. It is usually a directory that contains a `SKILL.md` file plus any supporting files the skill needs. The harness copies or patches from this starting point to produce candidate skill versions during a run.
- **Candidate skill**: an improved version of the seed skill produced by a research iteration. Producer evals run against this candidate, and judge evals score the producer output.
- **Track**: a configured eval path for one skill responsibility, such as release summarization or security auditing. A project can define multiple tracks, but the current alpha run improves one seed skill at a time.
- **Baseline**: previously generated or imported eval output and scores used as the comparison point before researching improvements.

## Project Layout

Create a project directory with this shape:

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
    baseline/
      ...
```

Use `fixtures/projects/release-notes-alpha/` as the working example.

This single-skill layout uses `seed-skill/` because the alpha fixture improves one skill.

For a multi-skill project, keep the same root concepts but colocate the candidate skills under `skills/`:

```text
skills-autoresearch-security/
  config.json
  program.md
  evals/
    eval-cases.json
    rubric.md
  reference/
    ...
  skills/
    security-audit/
      SKILL.md
    secure-authoring/
      SKILL.md
  workspace/
    baseline/
      ...
```

The important parts are not the exact directory names for every project, but that `config.json` and the run payload point at the correct project root and seed skill directory.

## Config

`config.json` tells the harness what skill is being improved, how many iterations to run, and which models to use.

```json
{
  "skill_name": "release-notes",
  "topic_group": "developer-communications",
  "origin_skill": "fixtures/projects/release-notes-alpha/seed-skill",
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
      "id": "summarise",
      "eval_type": "summarise-changelog",
      "role": "task-producer",
      "target_skill": "release-summary"
    }
  ]
}
```

Important fields:

- `origin_skill`: default path to the seed skill directory, relative to the project root unless absolute.
- `target_score`: normalized score required to stop early.
- `max_iterations`: maximum candidate-improvement attempts.
- `models.producer`: model that produces eval outputs. The default config uses a cheaper/smaller model here.
- `models.judge`: model that scores producer outputs. The default config uses a stronger model here.
- `models.researcher`: model that patches the skill.
- `roles.judge`: Flue role used for judging.
- `tracks[].role`: Flue role used by the producer.

These role/model choices are starting suggestions, not requirements. Try different producer, judge, and researcher models for your project, then compare cost, speed, score stability, and the usefulness of the resulting candidate skill.

Flue roles live under `.flue/roles/`. Add a new role file if your project needs a different producer or judge role.

For a multi-skill project, use one track per skill or skill responsibility. For example, a security project might have an `audit` track that targets `skills/security-audit` and an `authoring` track that targets `skills/secure-authoring`.

## Seed Skill Selection

`origin_skill` is the `config.json` field for the default seed skill. The harness uses this path when a run payload does not provide a skill override.

`seedSkillDir` is the run payload override for one invocation. Do not add it to `config.json`; pass it in the JSON payload you send to `flue run autoresearch` when you want that specific run to improve a different skill directory.

For example, this config default improves the audit skill:

```json
{
  "origin_skill": "skills/security-audit"
}
```

To improve the authoring skill without editing `config.json`, keep the config default as-is and pass `seedSkillDir` in that run's payload:

```json
{
  "projectRoot": "path/to/skills-autoresearch-security",
  "withBaseline": true,
  "runResearch": true,
  "seedSkillDir": "path/to/skills-autoresearch-security/skills/secure-authoring",
  "sessionId": "security-authoring-research"
}
```

Current alpha behavior improves one seed skill per run. For multi-skill projects, run the harness once per target skill.

## Eval Cases

`evals/eval-cases.json` contains one or more eval cases:

```json
{
  "evals": [
    {
      "id": "notes-001",
      "eval_type": "summarise-changelog",
      "title": "Summarise a small changelog for users",
      "input": {
        "file": "CHANGELOG.md"
      },
      "expectations": {
        "must_include": ["parser", "migration note", "risk"]
      },
      "scoring_dimensions": [
        {
          "id": "clarity",
          "label": "Clear user-facing summary",
          "max_score": 1
        }
      ]
    }
  ]
}
```

Keep early alpha evals small and concrete. One or two focused evals produce better debugging signal than a broad suite.

## Rubric

`evals/rubric.md` should say what a high-quality output must do. The judge sees this context through the project files and eval case, so be direct:

```md
# Rubric

A high-scoring answer:

- Names the user-visible change.
- Mentions migration or compatibility impact.
- Notes meaningful risk or verification guidance.
```

## Input And Reference Files

Put task inputs under `input/` and stable supporting material under `reference/`.

The producer sees:

- eval case JSON
- input files
- reference files
- candidate skill files

The judge sees:

- eval case JSON
- reference files
- producer output files

The judge should not score skill instructions directly.

## Baseline

The safest first run is an imported baseline. It lets you validate project loading and aggregation before spending model calls.

Required baseline shape:

```text
workspace/baseline/
  scores-0.json
  summary.json
  <eval-id>/
    task.md
    input/
    output/
```

Each score file must match the `EvalScore` shape:

```json
{
  "eval_id": "notes-001",
  "eval_type": "summarise-changelog",
  "track_id": "summarise",
  "total_score": 0.6,
  "max_score": 1,
  "dimensions": [
    {
      "id": "clarity",
      "score": 0.6,
      "max_score": 1,
      "rationale": "The baseline omits migration and risk details."
    }
  ],
  "summary": "Baseline is understandable but incomplete."
}
```

## Credentials

Model-backed runs use Varlock and 1Password. See [alpha-run.md](alpha-run.md) for the expected `dev/anthropic/api_key` setup.

Validate credentials:

```bash
pnpm run env:check
```

## Run A Baseline Smoke

To run the baseline smoke against the built-in alpha fixture in this repository:

```bash
pnpm run alpha:smoke
```

For your own project:

```bash
pnpm exec flue run autoresearch --target node --workspace .flue --id my-smoke --payload '{"projectRoot":"path/to/my-autoresearch-project","withBaseline":true,"runResearch":false,"sessionId":"my-smoke"}'
```

The command parts are:

- `pnpm exec flue run autoresearch`: runs the `autoresearch` Flue agent through the project-local `flue` dependency.
- `--target node`: uses the Node.js target for the run.
- `--workspace .flue`: stores Flue run state under the local `.flue/` workspace directory.
- `--id my-smoke`: gives this Flue run a stable ID. Use a short name that identifies what you are checking.
- `--payload '...'`: passes harness-specific options as JSON.

The payload fields are:

- `projectRoot`: path to the autoresearch project you want the harness to load.
- `withBaseline`: tells the harness to load or validate the baseline artifacts for the project.
- `runResearch`: controls whether the researcher should patch the skill. `false` makes this a smoke run that stops before model-backed research.
- `sessionId`: run/session name used when writing harness artifacts. Keeping this aligned with `--id` makes outputs easier to correlate.

This should return events ending with `research-loop-ready`.

## Run Autoresearch

To run autoresearch against the built-in alpha fixture in this repository:

```bash
pnpm run alpha:research
```

For your own project:

```bash
varlock run -- pnpm exec flue run autoresearch --target node --workspace .flue --id my-research --payload '{"projectRoot":"path/to/my-autoresearch-project","withBaseline":true,"runResearch":true,"seedSkillDir":"path/to/my-autoresearch-project/seed-skill","sessionId":"my-research"}'
```

For a multi-skill project, point `seedSkillDir` at the specific skill you want that run to improve:

```bash
varlock run -- pnpm exec flue run autoresearch --target node --workspace .flue --id security-audit-research --payload '{"projectRoot":"path/to/skills-autoresearch-security","withBaseline":true,"runResearch":true,"seedSkillDir":"path/to/skills-autoresearch-security/skills/security-audit","sessionId":"security-audit-research"}'
```

The run stops when either:

- `target_score` is reached, or
- `max_iterations` is exhausted.

## Inspect Results

After a successful run, inspect the `workspace/` directory inside your autoresearch project root, not the Flue `.flue/` workspace directory:

```text
my-autoresearch-project/workspace/iterations/1/
  skill/SKILL.md
  skill/RESEARCH.md
  skill/.autoresearch-flue-transcript.json
  outputs/<eval-id>/RESULT.md
  outputs/<eval-id>/producer-flue-transcript.json
  outputs/<eval-id>/judge-flue-transcript.json
  scores-0.json
  summary.json
```

Key questions:

- Did `skill/SKILL.md` improve the observed weakness without overfitting?
- Did the producer output satisfy the task, independent of the judge?
- Did the judge rationale cite actual producer output?
- Did the score improve over baseline for the right reason?
- Do transcripts avoid leaking secret values?

## Repeat Runs

Generated iteration artifacts are written with exclusive file creation. To rerun the same fixture from scratch, remove the generated iterations first:

```bash
rm -rf path/to/my-autoresearch-project/workspace/iterations
```

Keep committed fixtures baseline-only unless you intentionally want to preserve a specific alpha run artifact.
