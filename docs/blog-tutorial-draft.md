# Teaching an Agent When It Needs a Skill: A Hands-On Autoresearch Tutorial

> Draft based on a real run performed on 16 July 2026. The project is alpha software; the rough edges documented here were reproduced rather than inferred.

Agent skills are easy to add and surprisingly hard to justify. A detailed `SKILL.md` may improve a model's work, but it also consumes context, adds maintenance overhead, and can become obsolete as models improve. How do we know whether a skill is helping? If it is helping, how much of it do we actually need?

`skills-autoresearch-flue` is an experimental harness for answering those questions with evidence. It runs a task against a small eval fixture, scores the result, lets a researcher model make the smallest useful change to the skill, and evaluates the candidate again. Each phase leaves behind enough artifacts to inspect what happened.

In this tutorial, we will run the project's release-notes fixture from beginning to end. We will start with a baseline score of `0.6`, let the harness improve a deliberately thin skill, and finish with a candidate that scores `1.0`. Along the way, we will also encounter the kind of alpha-quality dependency failures, noisy output, and missing recovery behavior that a polished product would need to solve.

## The project in one sentence

The current north star is:

> Build a small, auditable Flue-based autoresearch harness that helps maintainers decide when skill context is worth using, and what the smallest useful skill should contain.

The important word is _decide_. The harness should not assume that every weak output needs a larger skill. The evidence may instead suggest a smaller skill, better reference material, another producer model, a narrower eval, or no skill at all.

## What is Flue?

[Flue](https://github.com/withastro/flue) is an open-source TypeScript framework for building AI agents around a programmable agent harness. It provides primitives for agents, sessions, tools, skills, sandboxes, structured results, and deployable workflows.

This project uses Flue as the layer that runs and isolates the researcher, producer, and judge. Flue manages their model sessions and working environments, while `skills-autoresearch-flue` supplies the research loop, eval fixtures, scoring rules, stopping conditions, and audit artifacts.

## The three roles in a run

The model-backed path keeps three responsibilities separate:

1. The **researcher** reads score feedback and changes the skill.
2. The **producer** uses the candidate skill to perform the eval task and write output files.
3. The **judge** scores only the producer's output against the eval and rubric.

The producer does not grade itself, and the judge does not reward instructions merely because they appear in `SKILL.md`. This separation is one of the project's most important constraints.

The bundled fixture uses Claude Sonnet 4.6 for research and judging, and Claude Haiku 4.5 for production. The configuration assigns a model to each responsibility independently, so different models can already be mixed within the currently supported Anthropic provider. The longer-term intent is to allow any supported provider and model combination—for example, evaluating one provider's producer model with another provider's judge—but the committed schema and model client are Anthropic-only today.

## What we are going to produce

The fixture starts with this skill:

```md
# Release Summary

Summarise changelog entries for a developer audience.

Keep the output concise and focus on what changed.
```

That is enough to produce something plausible, but not enough to reliably cover migration risk. Our tangible outcome will be:

- an improved candidate `SKILL.md`;
- a release-note `RESULT.md` produced with that candidate;
- an independent judge score and rationale;
- a before/after score of `0.6 → 1.0`;
- transcripts and a call-count summary that make the run auditable.

## Prerequisites

The repository requires Node 24 or newer and pnpm. The walkthrough used:

```text
Node v24.18.0
pnpm 11.1.2
```

Install dependencies:

```bash
pnpm install
```

### Alpha warning: the committed dependency graph was broken

On the checkout used for this walkthrough, the first smoke run failed because Wrangler `4.95.0` did not satisfy `@cloudflare/vite-plugin`'s `^4.98.0` peer requirement. After correcting Wrangler, execution failed again because `@flue/cli` was `0.9.2` while `@flue/runtime` was `0.10.1`.

The verified fix was to align the Flue packages, declare a compatible Wrangler, and update the removed runtime type entrypoint:

```bash
pnpm add --save-dev @flue/cli@0.10.1
pnpm add --save-dev wrangler@^4.98.0
```

The source import also changed from `@flue/runtime/client` to `@flue/runtime`. This is tracked in [issue #84](https://github.com/schalkneethling/skills-autoresearch-flue/issues/84). If that issue is closed by the time you read this, a fresh `pnpm install` should be enough.

## Tour the fixture before running it

The example project lives under:

```text
fixtures/projects/release-notes-alpha/
├── config.json
├── evals/
│   ├── eval-cases.json
│   └── rubric.md
├── input/CHANGELOG.md
├── reference/context.md
├── seed-skill/SKILL.md
└── workspace/baseline/
```

This is a useful mental model for any autoresearch project:

- `input/` contains task-specific material.
- `reference/` contains stable context that is not itself skill guidance.
- `seed-skill/` contains the starting instructions to improve.
- `evals/` defines the task and what good work means.
- `workspace/` contains the evidence produced by runs.

The task input is deliberately small. `input/CHANGELOG.md` contains:

```md
# Changelog

## 0.4.0

- Replaced the markdown parser with a stricter CommonMark-compatible parser.
- Deprecated the legacy `parseReleaseNotes()` helper.
- Added migration notes for custom renderer integrations.
```

The complete eval case in `evals/eval-cases.json` is:

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

Finally, `evals/rubric.md` tells the judge how to interpret that clarity dimension:

```md
# Rubric

Score the release note output for clarity and usefulness to a developer audience.

A high-scoring answer:

- Names the user-visible change.
- Mentions migration or compatibility impact.
- Notes meaningful risk or verification guidance.
```

Taken together, these files make the task and its success criteria inspectable: summarize three concrete changelog facts, explicitly cover the parser, migration notes, and risk, and present them clearly for developers.

The imported baseline has a normalized score of `0.6`, below the configured target of `0.8`.

## Step 1: validate the no-cost path

Run the committed baseline smoke test:

```bash
pnpm run alpha:smoke
```

This imports existing baseline artifacts and does not call a model. After fixing the dependency mismatch, the walkthrough produced:

```json
{
  "completedIterations": 0,
  "normalizedScore": 0.6,
  "events": ["project-loaded", "cost-preview", "baseline-imported", "aggregated", "research-loop-ready"]
}
```

The cost preview correctly planned zero calls because this command only validates and aggregates a committed baseline.

This is a valuable first gate. It tells us that project paths, config parsing, baseline loading, and aggregation work before credentials or model spend enter the picture.

## Step 2: understand why the baseline falls short

Open these two files:

```text
workspace/baseline/notes-001/output/RESULT.md
workspace/baseline/scores-0.json
```

The baseline producer output is only one sentence:

```md
The release updates the markdown parser and adds migration notes.
```

The corresponding score artifact records both the result and the judge's reasoning:

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
      "rationale": "The summary identifies the parser change but omits risk and deprecation details."
    }
  ],
  "summary": "Baseline is understandable but incomplete."
}
```

The output mentions the parser change and migration guidance, but the rationale makes the shortfall concrete: it says nothing about risk or the deprecated helper. This is exactly the kind of specific gap a researcher should be able to act on.

The goal is not “write a better skill” in the abstract. It is “make the smallest change that addresses observed failures without bloating the skill or overfitting to one example.”

## Step 3: configure credentials

[Varlock](https://varlock.dev/guides/schema/) is an environment-variable toolkit. This project uses it to declare that `ANTHROPIC_API_KEY` is required and sensitive, validate that a value is available, and inject the resolved configuration into the Flue process without hard-coding a key in the repository.

The committed `.env.schema` uses Varlock's optional [1Password plugin](https://varlock.dev/plugins/1password/) as its default secret source:

```dotenv
# @plugin(@varlock/1password-plugin)
# @initOp(allowAppAuth=true, account=https://my.1password.com/)

# @sensitive @required
ANTHROPIC_API_KEY=op(op://dev/anthropic/api_key)
```

In a 1Password secret reference, `op://dev/anthropic/api_key` means:

- `dev`: the name of the maintainer's 1Password vault;
- `anthropic`: the item stored in that vault;
- `api_key`: the field containing the secret.

The `dev` name is a repository convention, not a special Varlock environment or a requirement imposed by the harness.

You do not need 1Password to run the project. Varlock gives values already present in the process environment higher precedence than values in `.env.schema`; its [environment documentation](https://varlock.dev/guides/environments/) describes the complete precedence order. You can therefore supply `ANTHROPIC_API_KEY` through your shell, CI secret store, or another secret manager before invoking the same script:

```bash
ANTHROPIC_API_KEY="your-key" pnpm run alpha:research
```

You could also place the value in a gitignored `.env.local` file for local development, although an external secret manager avoids storing the key as plaintext on disk. Never commit the resolved key.

Validate resolution without printing the secret:

```bash
pnpm run env:check
```

A successful check marks `ANTHROPIC_API_KEY` and `FLUE_MODEL` as resolved and sensitive. When the key comes from the shell, Varlock reports it as a `process.env override`; otherwise, the committed setup fetches it from 1Password.

Varlock therefore handles validation and injection, while 1Password is only the default secret backend chosen for this checkout. The model client itself remains Anthropic-only; cross-provider model support is a separate piece of future work.

## Step 4: run one real research iteration

Run:

```bash
pnpm run alpha:research
```

The script invokes Flue with an imported baseline, research enabled, and the release-notes seed skill selected. Because `0.6` is below the `0.8` target, the harness continues into research.

Before spending, it plans three calls:

```text
researcher            1
iteration producer    1
iteration judge       1
total                 3
```

The researcher identifies the score gap and patches the skill. The candidate adds four practical instructions:

```md
For each notable change:

- Name the user-visible change clearly.
- Include any migration or compatibility notes (e.g. deprecations, breaking changes, required action).
- Note meaningful risk or verification guidance so developers know what to test or watch for.

Avoid marketing language. Prioritise completeness for migration risk over brevity.
```

This is a modest change, not a rewrite. The producer then uses that candidate to create release notes with explicit parser, migration, deprecation, and verification sections. Finally, the independent judge awards `1/1` for clarity.

The completed workflow reports:

```json
{
  "completedIterations": 1,
  "normalizedScore": 1,
  "events": [
    "project-loaded",
    "cost-preview",
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

## Step 5: inspect the evidence, not only the score

The most useful output is not the terminal's final `1.0`. Inspect:

```text
workspace/iterations/1/
├── skill/
│   ├── SKILL.md
│   ├── RESEARCH.md
│   └── .autoresearch-flue-transcript.json
├── outputs/notes-001/
│   ├── RESULT.md
│   ├── producer-flue-transcript.json
│   └── judge-flue-transcript.json
├── scores-0.json
└── summary.json
```

Ask five questions:

1. Did the candidate change only what the feedback justified?
2. Is the produced result factually grounded in the changelog and reference material?
3. Does the judge rationale cite evidence from the output?
4. Did the aggregate improve without hiding a per-eval regression?
5. Would the candidate remain useful outside this one fixture?

For this run, the score improvement is easy to explain. The seed asked only for concision and a description of what changed. The candidate explicitly requested migration impact and risk guidance. The output contains both, and the judge rationale points to those sections.

There is still a caveat: one eval with one binary scoring point is weak evidence. The run proves the machinery and produces a plausible improvement; it does not establish that the candidate generalizes across diverse changelogs.

## Step 6: inspect model calls and cost

The run writes `workspace/cost-summary.json`. Planned and actual call counts both equal three, which is useful. However, every token counter is zero for this Flue run, so no observed dollar estimate is available.

Cost preview and budget support are documented and implemented in part, but [issue #19](https://github.com/schalkneethling/skills-autoresearch-flue/issues/19) remains open. The issue should be reconciled with current behavior: call-count preview exists, while Flue token usage and reliable dollar enforcement remain incomplete.

## Step 7: rerunning is deliberately awkward today

Iteration files are written conservatively to preserve evidence. Running the same research fixture again can collide with existing artifacts. The current workaround is to remove generated iterations before starting over:

```bash
rm -rf fixtures/projects/release-notes-alpha/workspace/iterations
```

That is risky tutorial ergonomics and easy to forget. A supported cleanup flag is tracked in [issue #10](https://github.com/schalkneethling/skills-autoresearch-flue/issues/10).

More importantly, if a provider or network failure happens halfway through an expensive run, the harness cannot yet resume at the missing phase. Phase-aware recovery is the project's only current `p0` feature issue: [issue #55](https://github.com/schalkneethling/skills-autoresearch-flue/issues/55).

## What is possible today

The alpha can already:

- import or generate a baseline;
- stop before research when the baseline already reaches the target;
- start from a seed skill or an empty candidate with the seed used as reference;
- run separate researcher, producer, and judge phases;
- use multiple eval cases with bounded concurrency;
- reject a target-reaching aggregate when an individual eval regresses below baseline;
- write candidate skills, outputs, scores, summaries, transcripts, and call counts;
- improve one seed skill per invocation.

## Current bugs and rough edges

| Finding from this walkthrough                                                                  | Status                                                                             |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Clean install could not run Flue because CLI/runtime and Wrangler versions were incompatible   | [#84](https://github.com/schalkneethling/skills-autoresearch-flue/issues/84)       |
| Normal terminal output exposes long model reasoning and generated content                      | [#17](https://github.com/schalkneethling/skills-autoresearch-flue/issues/17)       |
| Common runs require long, plumbing-heavy Flue payloads outside the convenience fixture scripts | [#12](https://github.com/schalkneethling/skills-autoresearch-flue/issues/12)       |
| Reruns require manual cleanup                                                                  | [#10](https://github.com/schalkneethling/skills-autoresearch-flue/issues/10)       |
| Failed runs cannot resume from the latest trustworthy phase                                    | [#55](https://github.com/schalkneethling/skills-autoresearch-flue/issues/55)       |
| Flue call counts are captured, but this run exposed no token usage or dollar estimate          | [#19](https://github.com/schalkneethling/skills-autoresearch-flue/issues/19)       |
| Generated phase workspaces and iteration artifacts were not ignored by Git                     | Fixed in the walkthrough branch; should be included with #84 or tracked separately |
| `pnpm run format:check` fails on existing repository files                                     | Not currently tracked                                                              |

Two tracker housekeeping items are also worth noting. [Issue #65](https://github.com/schalkneethling/skills-autoresearch-flue/issues/65) asks for skill-creator attribution, but the README already contains an acknowledgements section. [Issue #19](https://github.com/schalkneethling/skills-autoresearch-flue/issues/19) describes capabilities now partly present. Both need acceptance-criteria review rather than being presented as wholly missing.

## What is coming next

The issue tracker points to a coherent progression:

- Reliability first: resume failed runs ([#55](https://github.com/schalkneethling/skills-autoresearch-flue/issues/55)) and support safe reruns ([#10](https://github.com/schalkneethling/skills-autoresearch-flue/issues/10)).
- Make the tool pleasant to operate: shorter commands ([#12](https://github.com/schalkneethling/skills-autoresearch-flue/issues/12)), quiet output ([#17](https://github.com/schalkneethling/skills-autoresearch-flue/issues/17)), and a richer run report ([#18](https://github.com/schalkneethling/skills-autoresearch-flue/issues/18)).
- Improve the quality of researched skills: place durable material in references, scripts, or assets ([#64](https://github.com/schalkneethling/skills-autoresearch-flue/issues/64)); review the candidate skill itself ([#63](https://github.com/schalkneethling/skills-autoresearch-flue/issues/63)); and evaluate trigger phrasing ([#61](https://github.com/schalkneethling/skills-autoresearch-flue/issues/61)).
- Broaden only after the loop is dependable: multi-skill runs ([#8](https://github.com/schalkneethling/skills-autoresearch-flue/issues/8)) and cross-provider judging.

## What this run taught us about the project's goal

The existing goal is strong and does not need a conceptual rewrite. The useful sharpening is about sequencing:

> Before expanding providers, skill formats, or multi-skill orchestration, make one small run dependable, restartable, affordable to inspect, and easy to invoke.

The next milestone should therefore be a **reliable single-skill research loop**. A user should be able to install the project, run a baseline, complete or resume one research iteration, understand the result, and rerun safely without editing JSON payloads or deleting evidence by hand.

That milestone would turn today's promising alpha into a trustworthy foundation for the more ambitious question at the heart of the project: when does an agent genuinely need a skill, and what is the smallest skill worth keeping?

---

## Author notes for the next draft — remove before publishing

This first walkthrough served its purpose as a maintainer reorientation exercise. It reconstructed the project goal, proved that the core loop still works, exposed dependency and workflow gaps, and produced real before-and-after evidence. It should not, however, be treated as the final reader journey.

### Change the primary scenario to an external project

The current article runs `fixtures/projects/release-notes-alpha/`, which lives inside the harness repository and benefits from repository-specific scripts such as `pnpm run alpha:smoke` and `pnpm run alpha:research`. That is useful for harness development, but it is not the common end-user setup.

The final tutorial should start with two separate directories:

```text
/path/to/skills-autoresearch-flue/  # the installed or cloned harness
/path/to/the-user-project/          # the skill project being researched
```

The user should run the harness against an external, absolute `projectRoot` and point `seedSkillDir` at a skill in that project. The walkthrough must verify path resolution from the harness working directory, where config and eval artifacts are written, which files remain in the external repository, and how the generated candidate is adopted after a successful run.

Use a realistic project and skill rather than moving the release-notes fixture elsewhere merely to demonstrate an absolute path. The scenario should begin with a recognizable user problem, exercise more than one representative eval if affordable, and finish with an artifact the reader would plausibly keep or ship.

The revised article should answer these questions explicitly:

- What must be installed in the harness checkout versus the user's project?
- Which command is run from which directory?
- Which paths in `config.json` resolve relative to the external project root?
- Which payload paths resolve relative to the shell working directory?
- Does the user's repository need Flue, Varlock, or harness dependencies installed locally?
- Where do baseline, iteration, transcript, and cost artifacts land?
- How does the user review and adopt the winning candidate skill?
- How can generated evidence be ignored or retained intentionally in the user's repository?
- How does the user rerun or resume without deleting valuable evidence?

Retain the local release-notes fixture as one of the following, rather than the main tutorial:

- a short maintainer-focused smoke-test sidebar;
- an appendix explaining the smallest possible fixture;
- a development diary describing what the reorientation run uncovered.

### Establish a publication gate

Do not publish the final tutorial until the path it recommends works from a clean checkout against a separate external repository. At minimum, rerun that journey on the exact commit the article will link to and record the commands and artifacts from that run.

Likely blockers to land or explicitly resolve before publication:

- [#84](https://github.com/schalkneethling/skills-autoresearch-flue/issues/84): a clean install must produce a compatible Flue CLI/runtime/Wrangler dependency graph.
- [#12](https://github.com/schalkneethling/skills-autoresearch-flue/issues/12): a normal external-project run needs a short, config-driven command instead of a long inline Flue payload.
- [#55](https://github.com/schalkneethling/skills-autoresearch-flue/issues/55): failed model-backed work should resume from the latest trustworthy phase.
- [#10](https://github.com/schalkneethling/skills-autoresearch-flue/issues/10): rerunning should not require a tutorial to recommend manual recursive deletion.

Strong candidates for the same publication milestone:

- [#17](https://github.com/schalkneethling/skills-autoresearch-flue/issues/17): default terminal output should be readable and should not dump long reasoning or generated content.
- [#19](https://github.com/schalkneethling/skills-autoresearch-flue/issues/19): reconcile the issue with the implemented call preview and clearly describe the remaining token-usage and dollar-budget limitations.
- Add or update documentation for secret injection without 1Password, making the maintainer's `dev` vault convention clearly optional.
- Fix or intentionally baseline the existing repository-wide `format:check` failures.
- Confirm that generated `.phase-workspaces/`, `iterations/`, and `cost-summary.json` files have an intentional version-control policy.

Review open issues immediately before the next draft. Some tracker descriptions already lag behind the implementation—particularly #19 and #65—so the article should describe verified behavior, not repeat issue titles as if every acceptance criterion were still missing.

### Evidence worth carrying forward

Keep these findings from the first walkthrough available when rebuilding the article:

- The seed skill was deliberately thin and the baseline output scored `0.6`.
- The researcher made a small, explainable change instead of rewriting the skill.
- Separate researcher, producer, and judge calls produced a `1.0` candidate.
- The planned and actual call counts matched at three.
- Flue call records exposed no token usage, so observed dollar cost remained unknown.
- The dependency failures demonstrated the need to test installation and packaged execution, not only unit tests.
- One eval with one scoring point proves the loop but is not strong evidence of generalization.

For the final post, preserve this evidence-first style: show relevant file contents before interpreting them, explain unfamiliar infrastructure at the point where it appears, distinguish project conventions from actual requirements, and link to authoritative external documentation when a full explanation would distract from the tutorial.
