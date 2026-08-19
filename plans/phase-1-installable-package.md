# Phase 1 — Installable, Release-Ready Skills Autoresearch Package

## Objective

Convert the repository-only harness into an installable CLI-only npm package named
`@schalkneethling/skills-autoresearch` and prove that the packed tarball works outside the source checkout without credentials.

This phase treats the packed tarball as the product evidence. It establishes the package and artifact contracts needed by the later secure-release phase without implementing Changesets, Fledgling, or OIDC publication.

Tracking: [#135](https://github.com/schalkneethling/skills-autoresearch-flue/issues/135), under adoption epic [#134](https://github.com/schalkneethling/skills-autoresearch-flue/issues/134).

## Package Contract

- Keep the repository root private for development tooling, fixtures, tests, and orchestration.
- Move publishable source and the deterministic-asset catalog beneath `packages/skills-autoresearch/`.
- Use the MIT license at repository and package level, with a test preventing drift.
- Make the packed manifest provenance-ready with the canonical repository URL, workspace directory, homepage, issues URL, author, keywords, Node engine, and public/provenance publish configuration.
- Keep the package CLI-only, without public root or wildcard TypeScript exports.
- Preserve the `skills-autoresearch` and `skills-autoresearch-flue` binaries.
- Add consistent `--version` output and reliable executable entrypoints with shebangs.
- Resolve bundled product assets relative to the installed package and project-specific roles relative to the selected project.
- Disable lifecycle scripts by default and prove installation works without them.
- Keep Varlock for local model credentials only; npm publication remains token-free.

The published allowlist contains compiled runtime files, the deterministic catalog, README, CHANGELOG, LICENSE, and package metadata. Tests, fixtures, transcripts, workspaces, compatibility projects, plans, demos, environment files, and the repository Agent Skill remain outside the tarball.

## GitHub Stack

The installed `gh stack` extension manages this stack:

```text
main
  └── codex/installable-package-workspace
        └── codex/installable-package-runtime
              └── codex/installable-package-proof
```

The root agent alone manages stack ancestry, rebases, pushes, PR metadata, and merge handoff. Draft PRs are submitted with `gh stack submit --auto` and inspected with `gh stack view --json`. Lower-layer corrections are made on their owning branch and propagated with `gh stack rebase --upstack`. The stack is not merged or marked ready without user direction.

## PR 1A — Behavior-Preserving Package Move

- Add `packages/*` to the pnpm workspace.
- Move product source and catalog into the public package.
- Split package compilation from root test/typecheck configuration.
- Move runtime dependencies into the package while retaining development tooling at the private root.
- Add provenance-ready metadata, MIT license, and the exact file allowlist.
- Update repository scripts, imports, Vitest, ESLint, Knip, TypeScript, and documentation paths.
- Preserve existing behavior.

Red: the root build cannot represent an isolated public package.

Green: the package builds independently while existing tests and commands remain unchanged.

## PR 1B — Installed Runtime Correctness

- Add one internal package-resource resolver.
- Use the bundled deterministic catalog by default while preserving `--catalog-root`.
- Validate roles from the selected project rather than ambient `process.cwd()`.
- Make `release-notes-alpha` self-contained with its required role files.
- Add executable wrappers and `--version` to both binaries.
- Correct installed CLI help and test execution from unrelated directories and paths containing spaces.

Red: catalog and role resolution depend on the checkout or caller’s directory.

Green: catalog ownership and project-role ownership are explicit and portable.

## PR 1C — Authoritative Tarball and Clean-Room Proof

- Add `publint` and deterministic package-contract checks to `pnpm run check`.
- Establish one authoritative pack command producing `packages/schalkneethling-skills-autoresearch-<version>.tgz`.
- Make inspection, installation, demos, and future CI consume the exact path returned by that command.
- Reject missing, duplicate, unrelated, or unexpectedly named archives.
- Inspect the manifest inside the tarball and validate identity, provenance metadata, binaries, dependencies, and complete inventory.
- Print the archive path, SHA-256, size, and contents summary.
- Install the same archive offline into a temporary directory containing spaces.
- Add the demo runbook and progress post.

Red: no unambiguous installable archive exists outside the checkout.

Green: one inspected tarball completes the credential-free clean-room workflow.

## TDD, Review, and Audit

- A test-focused subagent writes each failing contract before implementation.
- A high-reasoning implementer handles relocation and runtime behavior.
- Root owns shared manifests, public contracts, integration, and GitHub operations.
- At most two editing agents work concurrently with disjoint ownership.
- Root reviews diffs and callers, runs focused tests, and returns defects to the responsible agent.
- The same agent corrects accepted findings before root re-review.
- An independent high-reasoning auditor reviews the complete stack only after root acceptance.

## Verification and Communication

The clean-room proof copies the self-contained fixture outside the repository, removes model credentials, installs the exact inspected archive offline, runs help and version through both binaries, imports the baseline with score `0.600` and zero calls, and runs recorded-response determinization without `--catalog-root`. It asserts one opportunity, three recommendations, all six determinization artifacts, and byte-identical source inputs before and after.

Final checks include package build, package contracts, packed-manifest inspection, `publint`, clean-room installation, `pnpm run check`, Flue compatibility, `alpha:smoke`, manual inspection, and green CI.

Communication artifacts:

- `docs/demos/phase-1-installable-package.md`
- `docs/progress/phase-1-installable-package.md`
- a reusable demo script with `--keep`

Post angle: **From repository-only alpha to an installable Skills Autoresearch CLI.**

## Phase 2 Handoff and Deferrals

Phase 2 adapts Calavera’s release architecture: Changesets version PRs; pinned, dry-run-first Fledgling trust bootstrap; a protected publish environment; token-free OIDC; separate test, build, and publish jobs; SHA-pinned Actions; exact archive handoff without rebuilding; retry-safe registry checks; `next` prereleases; and provenance, dist-tag, registry, and consumer verification.

Template creation, public TypeScript APIs, CLI consolidation, Markdown eval authoring, AI-assisted eval bootstrap, Agent Plugin delivery, and credential-backed execution remain deferred.
