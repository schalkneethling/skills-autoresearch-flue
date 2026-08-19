# Installable Skills Autoresearch and Template Adoption

## Objective

Enable someone to:

1. Create a repository from the proposed `schalkneethling/skills-autoresearch-template` after Phase 6 creates and configures it as a GitHub template.
2. Clone it locally.
3. Copy their skill into `seed-skill/`.
4. Author evals manually or generate an AI-assisted draft.
5. Validate the project without credentials.
6. Run a no-skill baseline or improve an existing skill.
7. Execute through Flue/API or an external subscription-backed agent where applicable.
8. Inspect auditable results, costs, candidates, and determinization opportunities.

The proposed public package is:

```text
@schalkneethling/skills-autoresearch
```

Flue 2 remains the current runtime implementation, but it is not part of the public product compatibility contract.

## Guiding Decisions

- The public product is Skills Autoresearch, not a Flue-specific utility.
- Publishable source and packed artifacts use explicit locations beneath `packages/`.
- Human-friendly Markdown is the recommended eval authoring format; existing JSON remains supported.
- AI-assisted eval design produces a reviewable draft and never silently replaces accepted fixtures.
- Credential-free prepare, import, and validation paths are first-class product surfaces.
- Flue is the integrated execution path, not the only supported execution path.
- The no-skill baseline followed by immutable skill guidance is a first-class template preset.
- Agent Plugins may provide a complementary skill-delivery mechanism, but it is not required and initially includes no MCP server.
- Every delivery phase ends with a meaningful written post and a short reproducible demo that shows visible forward movement.
- Red/green TDD is the default implementation method: establish the failing behavior first, implement the smallest green change, then refactor without weakening the test.
- Major phases remain gated; later phases do not begin merely because an earlier PR exists.

## Delivery Phase Definition of Done

Every delivery phase must define its communication outcome before implementation begins. The phase issue and acceptance matrix include:

- the user-visible story the phase proves;
- the first failing test or contract check that establishes the red state;
- the minimal green behavior;
- focused unit tests and the smallest useful cross-boundary test;
- a deterministic or recorded demo path wherever possible;
- a short live path when credentials or external services are central to the story;
- a demo runbook with setup, commands, expected output, cleanup, and fallback recording instructions;
- a written post with the problem, design choices, implementation, evidence, limitations, and next milestone;
- screenshots, terminal excerpts, fixture artifacts, or diagrams needed by the post and video;
- root review, correction turns, independent audit, and green CI.

The default content artifacts are:

```text
docs/demos/phase-<n>-<slug>.md
docs/progress/phase-<n>-<slug>.md
```

The post may ultimately be published from `schalkneethling.com`, but the phase keeps a versioned source draft or content brief close to the implementation. The user records the video; the engineering phase supplies a rehearsed demo script and stable demo state.

A phase has two gates:

1. **Engineering ready:** implementation, tests, review, audit, PRs, CI, demo fixture, demo runbook, and post draft are complete.
2. **Communication complete:** the written post and demo/video have been published or the user explicitly authorizes the next phase before publication.

The next major delivery phase waits for communication completion or explicit authorization.

## Preflight — Tracking, Pull Requests, and Contract Freeze

Create a `p1` adoption epic titled:

> Deliver installable Skills Autoresearch and template-based onboarding

Create or align issues for:

- package workspace migration;
- secure release automation;
- human-friendly eval authoring;
- project validation;
- portable eval bootstrap;
- Flue Evaluation Designer;
- template repository;
- clean-room adoption testing;
- Agent Plugin experiment;
- README integration;
- launch post.

Existing issue #9, **Support human-friendly eval authoring**, is the foundation for the new eval source format.

Freeze these contracts before implementation:

- package name and CLI binary;
- supported Node and pnpm versions;
- project layout;
- canonical eval representation;
- human-authored Markdown format;
- bootstrap request and response schemas;
- package resource-resolution rules;
- generated artifact locations;
- template-to-harness version compatibility.

### Pull request landing gate

The kickoff review on 2026-08-11 produced this landing decision:

- Merged #130, ESLint 10.8.1, after final green-check confirmation.
- Merged #131, Knip 6.32.0, after rebasing its lockfile change and rerunning all required checks.
- Merged #133, Wrangler 4.119.0, after final green-check confirmation.
- Do not merge #132 as-is. pi-ai 0.84.1 is type-incompatible with the pi-ai 0.83 dependency line used by Flue 2.0.3, producing duplicate incompatible provider types in the Flue runtime tests. Revisit when Flue updates its dependency line or when an intentional adapter/dependency-resolution change is separately designed and tested.
- Keep #93, the TypeScript 7 update, out of scope for this delivery kickoff.

Local `main` was updated to the combined dependency state and `pnpm run check` passed, including 171 root tests, the Flue 2 compatibility fixture, build, and the zero-model-call alpha smoke. Revalidate open PR and dependency state again if implementation kickoff occurs after additional repository changes.

### Acceptance

- Every phase has an issue and acceptance matrix.
- Dependencies and merge gates are explicit.
- Flue-specific implementation details remain behind internal adapters.
- Work begins from an updated `main`, not an unrelated branch.

This is a preflight gate rather than a public delivery phase, so it does not require its own post and demo. Its output is the stable starting point for Phase 1.

## Phase Communication Map

| Phase                                       | Meaningful demo                                                                                                                                                                                                     | Written post angle                                                                      | Red/green proof                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Installable package                     | Pack into `packages/`, install the tarball in a clean directory with spaces, then run help/version, the existing credential-free smoke, and determinization                                                         | **From repository-only alpha to an installable Skills Autoresearch CLI**                | Red: installed CLI cannot resolve runtime assets outside the checkout. Green: the packed CLI completes the clean-room flow.                                                                   |
| 2 — Secure releases                         | Walk a Changeset through the release plan, show Fledgling verification, checksum-preserved tarball handoff, and tokenless OIDC publication or a protected rehearsal                                                 | **Publishing an AI developer tool without long-lived npm tokens**                       | Red: release contracts reject an untrusted publisher, wrong tarball path, rebuild, or checksum drift. Green: the protected exact-artifact flow passes.                                        |
| 3 — Human-friendly evals and validation     | Convert or author one eval in Markdown; show an invalid case fail clearly, then fix it and validate successfully while legacy JSON still loads                                                                      | **Evals humans can actually review**                                                    | Red: Markdown eval is unsupported or malformed input is accepted poorly. Green: Markdown normalizes canonically and diagnostics identify the exact problem.                                   |
| 4 — Portable eval bootstrap                 | Prepare a prompt, run it through Codex or Claude Code, import the response, inspect cited Markdown drafts, and reject one stale response                                                                            | **Bring your own agent to evaluation design**                                           | Red: external output cannot be safely imported or stale evidence is accepted. Green: shared schemas and fingerprints make the round trip safe.                                                |
| 5 — Flue Evaluation Designer                | Run the same bootstrap through one integrated command and compare its artifacts with the external-agent path                                                                                                        | **Convenience without runtime lock-in**                                                 | Red: the Flue path bypasses or diverges from the portable importer. Green: both paths converge on identical validation and artifact contracts.                                                |
| 6 — Template repository                     | Create from the template, clone, drop in a skill, choose a preset, install, and reach a credential-free ready state                                                                                                 | **From an existing skill to an autoresearch-ready repository**                          | Red: untouched placeholders or unsafe configuration pass. Green: the template gives actionable failures and then validates after the minimum edits.                                           |
| 7 — Complete clean-room adoption and launch | Create from the template, bootstrap and validate evals, generate a no-skill baseline, introduce immutable skill guidance when needed, run a constrained iteration, and inspect score/cost/determinization artifacts | **From a skill to an auditable improvement: the complete Skills Autoresearch workflow** | Red: the documented clean-room journey fails against the released package/template pair. Green: the complete workflow proves isolation, gating, auditable output, and documentation accuracy. |
| Optional episode — Agent Plugin experiment  | Load the skill-only plugin in a compatible client and run the portable bootstrap, or demonstrate with evidence why it adds no value                                                                                 | **Can one portable plugin teach multiple agents Skills Autoresearch?**                  | Red: plugin packaging or client behavior breaks the portable contract. Green: it adds measured convenience without becoming required; a negative result is also publishable evidence.         |

Each phase should prefer a five-to-ten-minute demo. A short demo is sufficient when it shows a real before/after, a meaningful safety boundary, and the next capability it unlocks.

## Phase 1 — Installable Package Workspace

Move the publishable product beneath:

```text
packages/
  skills-autoresearch/
    package.json
    README.md
    CHANGELOG.md
    src/
    catalog/
    ...
```

The repository root remains a private pnpm workspace responsible for development, fixtures, integration tests, and release orchestration.

### Scope

- Move runtime source and required assets into the package.
- Preserve stable CLI commands.
- Add package exports and bin definitions.
- Resolve bundled schemas, prompts, catalogs, and assets relative to the installed package.
- Remove assumptions about the harness repository or `process.cwd()`.
- Keep project paths external to and independent of the installed package.
- Add `publint`.
- Define the exact published `files` allowlist.
- Exclude fixtures, compatibility projects, transcripts, and development assets.

### Canonical tarball location

Local rehearsal and CI both use:

```text
packages/
  schalkneethling-skills-autoresearch-<version>.tgz
```

Packing always uses an explicit destination:

```bash
pnpm --filter @schalkneethling/skills-autoresearch \
  pack --pack-destination packages/
```

The release contract rejects:

- missing tarballs;
- multiple unexpected tarballs;
- incorrect package identity or version;
- unexpected or missing runtime files;
- changed checksums during artifact transfer;
- any publish-job attempt to rebuild the package.

### Clean-room test

Install the tarball into a temporary project outside the repository and run:

```text
install
  → CLI help
  → credential-free smoke
  → read-only determinization fixture
```

Include a path containing spaces.

### Suggested PR stack

```text
1A package workspace and resource layout
1B package metadata, exports, and installed-runtime behavior
1C pack inspection and clean-room installation tests
```

Do not stack release automation on this phase before the package contract is accepted and merged.

### Acceptance

- `pnpm pack` produces exactly one expected tarball beneath `packages/`.
- The package works outside the source repository.
- Runtime resources do not depend on checkout layout.
- Package contents are minimal and inspectable.
- Existing credential-free checks remain green.

## Phase 2 — Scripted Secure Releases

Adopt the established Calavera pattern using Changesets, Fledgling, Varlock, and npm trusted publishing.

### Responsibilities

#### Changesets

- Records semantic-version intent in feature PRs.
- Generates the version and changelog PR.
- Has no npm publication permission.

#### Fledgling

- Verifies package-name availability.
- Produces a reviewed bootstrap plan.
- Creates the initial npm package safely.
- Configures and verifies the GitHub trusted publisher.

#### Varlock

- Manages model-provider environment configuration.
- Never stores or supplies npm publishing credentials.
- Is not required by credential-free package validation or smoke tests.

#### GitHub Actions and OIDC

- Publishes without `NPM_TOKEN`.
- Uses a protected `publish` environment.
- Gives `id-token: write` only to the publish job.
- Separates test, build, and publish jobs.
- Publishes the exact tarball built and tested earlier.
- Pins actions to complete commit SHAs.

### Scripts

```text
changeset
release:status
release:version
release:prepare
release:publish
release:contracts
release:rehearse
publish:check
workflow:check
```

### Workflow

```text
Feature PR with Changeset
        ↓
Changesets release PR
        ↓
Version and changelog review
        ↓
Release creation
        ↓
Test job
        ↓
Build and pack into packages/
        ↓
Checksum and upload tarball
        ↓
Protected publish job
        ↓
Download and verify checksum
        ↓
Publish exact tarball through OIDC
```

### Suggested PR stack

```text
2A Changesets and release contracts
2B Fledgling bootstrap and release orchestrator
2C isolated OIDC workflow and rehearsal coverage
```

### Acceptance

- Initial package bootstrap is rehearsed and reviewed.
- No long-lived npm token exists.
- Fledgling verifies the repository, workflow, environment, and permission.
- Release PRs cannot publish.
- Publish jobs cannot rebuild.
- Stable and prerelease distribution tags are tested.
- `publint`, `zizmor`, package inspection, and clean-room installation pass.

## Phase 3 — Human-Friendly Eval Authoring and Validation

Build on issue #9.

### Recommended layout

```text
evals/
  cases/
    typical-request.md
    ambiguous-input.md
    likely-failure-mode.md
  rubric.md
```

Markdown frontmatter carries structured fields. The body contains readable task details, expectations, source evidence, and assumptions.

### Compatibility

- Existing `evals/eval-cases.json` remains supported.
- Markdown and JSON normalize into one canonical runtime representation.
- Runtime behavior does not vary based on source format.
- AI-generated drafts use Markdown by default.
- Migration tooling does not silently replace JSON projects.

### Project validator

Add:

```bash
skills-autoresearch validate --project .
```

Credential-free checks include:

- required project files;
- config schema;
- seed and guidance skill paths;
- placeholder content;
- eval IDs and types;
- track/eval consistency;
- input and reference paths;
- scoring dimensions;
- rubric presence;
- duplicate IDs;
- unsupported symlinks and path escapes;
- file-size limits checked before reading;
- workspace exclusions;
- model identifier syntax;
- budget configuration;
- unresolved bootstrap assumptions.

### Suggested PR stack

```text
3A Markdown eval schema and parser
3B canonical normalization and JSON compatibility
3C project validator, CLI, migration guidance, and docs
```

### Acceptance

- A user can author an eval without editing JSON.
- Existing projects continue to work unchanged.
- Markdown is straightforward to review in GitHub.
- Validation requires no model or credentials.
- Invalid projects fail before paid execution.

## Phase 4 — Portable AI-Assisted Eval Bootstrap

Create a runtime-neutral prepare/import protocol.

### Commands

```bash
skills-autoresearch init-evals prepare --project .

skills-autoresearch init-evals import \
  --project . \
  --response response.json
```

### Prepare artifacts

```text
workspace/eval-bootstrap/
  source.json
  request.json
  prompt.md
  response.schema.json
```

Preparation:

- inspects the complete supplied skill;
- fingerprints relevant sources;
- identifies responsibilities and constraints;
- requests typical, boundary, and failure-mode cases;
- requires citations for derived expectations;
- separates sourced requirements from assumptions;
- does not call a model;
- does not modify accepted eval files.

### Import behavior

- Validate the response schema.
- Verify source fingerprints.
- Reject stale responses.
- Reject unsafe and unknown paths.
- Generate review-friendly Markdown drafts.
- Preserve questions and assumptions.
- Never overwrite accepted fixtures without approval.
- Never start research.

### External-agent parity

The prepared prompt must work with:

- Codex;
- Claude Code;
- another local agent harness;
- a manually operated model;
- the optional integrated Flue path.

Every route uses the same request, response, import, and validation contracts.

### Suggested PR stack

```text
4A bootstrap schemas and source manifest
4B prepare/import implementation
4C external-agent instructions, fixtures, and parity tests
```

### Acceptance

- Prepare and import require no API key.
- External-agent usage is a primary documented path.
- Imported results are untrusted until validated.
- Flue-specific fields do not appear in portable schemas.
- AI output remains an explicitly human-reviewed draft.

## Phase 5 — Flue Evaluation Designer

Add a dedicated addressable Flue 2 role as an optional execution adapter.

### Command

```bash
skills-autoresearch init-evals run --project .
```

Internally:

```text
prepare
   ↓
Flue Evaluation Designer
   ↓
schema-validated response
   ↓
shared importer
```

### Role boundaries

- Reads only the bounded bootstrap request.
- Cannot modify the skill.
- Cannot write accepted eval files.
- Produces exactly one structured response.
- Does not run producer, judge, or researcher roles.
- Does not start baseline or research execution.
- Records usage and cost when provided.

### Acceptance

- Flue and external-agent responses use the same importer.
- The Flue shortcut produces equivalent artifacts.
- Prepare, import, and validate remain usable without Flue or API credentials.

## Phase 6 — Template Repository

Create and configure the currently nonexistent repository proposed as:

```text
schalkneethling/skills-autoresearch-template
```

The repository name remains a planned target until it is verified and created during this phase. Earlier phases must not link to it as though it already exists.

### Layout

```text
README.md
AGENTS.md
CLAUDE.md
config.json
evals/
  cases/
  rubric.md
input/
reference/
seed-skill/
workspace/
.env.schema
.gitignore
package.json
pnpm-lock.yaml
.github/
  workflows/
    validate.yml
  dependabot.yml
```

### Scripts

```text
validate
evals:prepare
evals:import
evals:design
smoke
baseline
research
resume
determinize
```

### Presets

#### Improve an existing skill

The seed skill is the initial candidate.

#### Guidance after baseline

```json
{
  "origin_skill": "seed-skill",
  "research_start": "empty"
}
```

The baseline runs without skill guidance. Research begins only when necessary, with the supplied skill treated as immutable guidance.

#### Manual evaluation only

Users author and validate evals without invoking an Evaluation Designer.

### Safety

- Generated iterations and transcripts are ignored.
- Accepted eval definitions remain version-controlled.
- No `.env` secrets are committed.
- Varlock is optional for external-agent and credential-free operations.
- CI runs only credential-free validation.
- Placeholder values fail validation clearly.

### Acceptance

- The repository is marked as a GitHub template.
- The proposed repository has been created under the intended owner, with its name and visibility explicitly verified before publication.
- New repositories contain no harness source duplication.
- The installed package is deliberately pinned.
- All three presets are documented and validated.
- Manual and AI-assisted workflows receive equal treatment.

## Phase 7 — Complete Clean-Room Adoption and Launch

Exercise the experience as a new user:

```text
Create from template
  → clone
  → install
  → copy real skill
  → prepare eval proposal
  → execute through selected agent
  → import
  → review Markdown
  → validate
  → generate baseline
  → run constrained research
  → inspect candidate and cost
  → run determinization
```

Validate separately:

- Flue/API execution;
- Codex subscription workflow;
- Claude Code subscription workflow where available;
- manual authoring;
- guidance-after-baseline;
- existing-skill improvement;
- paths containing spaces;
- missing and malformed project files;
- interrupted-run recovery;
- package/template version mismatch diagnostics.

### README and launch integration

The harness README and template README are verified as part of the clean-room journey rather than treated as a later documentation-only phase.

The harness README must:

- present the template as the recommended starting path;
- link to the npm package and template repository;
- retain lower-level manual setup documentation;
- explain Flue as the current runtime, not the product identity;
- document external-agent and manual alternatives prominently.

The phase-closing post and demo demonstrate:

```text
Bring a skill
  → create an eval proposal
  → review human-friendly evals
  → validate without credentials
  → establish a no-skill baseline
  → use the skill as guidance when necessary
  → run autoresearch
  → inspect the candidate and deterministic opportunities
```

The post includes real commands and artifacts, cost controls, human-review boundaries, producer/judge separation, Flue 2 role architecture, subscription-backed alternatives, alpha limitations, and package/template links.

### Acceptance

- Credential-free routes are fully proven.
- At least one constrained credential-backed run is manually inspected.
- Documentation matches observed commands and artifacts.
- The exact documented workflow succeeds against recorded package and template versions.
- The README links, final written post, and rehearsed video runbook are complete.
- Friction or ambiguity becomes tracked work instead of a hidden launch caveat.

## Optional Episode — Agent Plugin Experiment

This is non-blocking and begins only after the portable bootstrap contract is stable.

Package a portable Agent Skill:

```text
plugin.json
skills/
  design-autoresearch-evals/
    SKILL.md
    references/
    scripts/
```

Do not add an MCP server.

### Acceptance

- The plugin adds genuine convenience.
- It does not duplicate canonical bootstrap logic.
- It is not required by the template.
- Working Draft limitations and client compatibility are documented.
- If it provides no meaningful advantage, close the experiment without adoption.

## Orchestrated Multi-Agent Delivery

The root agent remains:

- orchestrator;
- contract owner;
- integration owner;
- first reviewer;
- Git and GitHub publisher;
- stack manager;
- final quality gate.

### Agent selection

- Package architecture, schemas, release security, and lifecycle: high-reasoning frontier agent.
- Frozen-interface implementation: balanced high-reasoning agent.
- Mechanical documentation and snapshots: balanced medium-reasoning agent.
- Adversarial tests and independent audits: independent high-reasoning agent.
- Shared integration and small corrections: root agent.

At most two editing subagents work concurrently, with disjoint file ownership.

### Subagent restrictions

Subagents must not:

- commit or push;
- create or modify PRs;
- update GitHub issues;
- alter frozen shared contracts without stopping;
- edit outside assigned ownership;
- broaden scope;
- delegate further unless explicitly authorized.

### Required review loop

1. Root freezes the phase behavior, demo slice, acceptance matrix, and intended red state.
2. A test-focused subagent writes or proposes the lowest useful failing tests.
3. Root runs the tests and confirms they fail for the intended missing behavior rather than a broken fixture or environment.
4. Root freezes the accepted tests and assigns bounded implementation work with disjoint ownership.
5. Subagent reports files, decisions, tests, assumptions, and gaps.
6. Root inspects the actual diff and affected callers.
7. Root runs focused tests and confirms the green behavior.
8. Root returns concrete defects or misunderstandings to the same implementer.
9. The implementer corrects the work.
10. Root re-reviews, retests, and permits refactoring only while the accepted tests remain green.
11. An independent audit agent reviews the root-accepted integration, safety boundaries, and demo reproducibility.
12. Root validates audit findings.
13. Legitimate corrections return to the responsible implementer.
14. Root runs the complete phase gate and clean demo rehearsal.
15. A documentation/demo subagent may prepare the evidence pack only after public behavior is stable.
16. Root alone commits, signs, pushes, and opens draft PRs.
17. Root monitors CI and corrects failures before handoff.

A subagent declaring completion never makes a PR ready.

## Stacked Pull Request Policy

Use stacks only for strictly dependent, independently reviewable layers. Keep at most three active PRs.

Do not stack:

- release automation on an unaccepted package contract;
- template work on an unpublished or unproven package;
- Flue execution on an unstable portable bootstrap schema;
- launch documentation on an unproven adoption journey;
- work across separate repositories as though it shared Git ancestry.

Each phase handoff includes:

- PRs in merge order;
- branch and signed commit;
- local checks;
- CI status;
- credential-backed validation status;
- root-review corrections;
- independent-audit findings;
- limitations and deferred work;
- exact dependency blocking the next phase.

The next major phase waits for merge unless explicitly authorized otherwise.
