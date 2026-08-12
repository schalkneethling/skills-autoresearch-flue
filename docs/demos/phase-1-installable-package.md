# Phase 1 demo: installable package

This demo shows the move from a repository-only alpha to an installable Skills Autoresearch CLI. It builds and inspects one authoritative tarball, installs that exact file offline in a clean room, and exercises both installed commands without model credentials. The clean room seeds dependency state from the repository's frozen lock before removing the deployed package files and installing the inspected archive; no package code or assets can leak from the checkout into the proof.

## Run it

From the repository root:

```bash
pnpm run demo:phase-1
```

Use `--keep` to preserve the temporary workspace for a live walkthrough:

```bash
pnpm run demo:phase-1 -- --keep
```

The demo prints the archive's absolute path, SHA-256, byte size, file count, smoke score, determinization counts, and clean-room workspace path.

## What to show

1. The archive inventory contains only compiled runtime files, the deterministic-asset catalog, package documentation, licenses, and metadata.
2. The repository's lock seeds a frozen offline dependency graph, after which the deployed package's `dist`, catalog, documentation, and license are removed.
3. The exact inspected tarball is added to that private consumer with lifecycle scripts disabled.
4. Both `skills-autoresearch` and `skills-autoresearch-flue` run from the resulting installed binary shims and report the packed version.
5. The Flue smoke path imports the fixture baseline, scores `0.600`, and makes zero model calls.
6. Recorded-response determinization uses the bundled catalog without `--catalog-root`, finds one opportunity and three recommendations, and writes exactly six artifacts.
7. Hash snapshots prove the skill, config, evals, input, reference, roles, and installed catalog are byte-identical after both runs.

The proof runs with lifecycle scripts disabled and provider credentials removed from child processes. It does not publish to npm or perform credential-backed model validation.
