# From repository-only alpha to an installable Skills Autoresearch CLI

Skills Autoresearch began as a harness you ran from its own checkout. That was useful for developing the workflow, but it was not yet a product another repository could depend on. Phase 1 changes that boundary: the harness now has an explicit npm package contract and an artifact we can inspect and install independently of the source tree.

## The tarball is the evidence

The central lesson carried over from Project Calavera is that a successful source build is not sufficient evidence for a package release. Consumers receive a tarball, so the exact tarball must be the thing we inspect, install, demonstrate, and eventually publish.

The authoritative pack step returns one canonical archive beneath `packages/`, along with its SHA-256, byte size, and complete inventory. Downstream tooling consumes the returned absolute path. It never guesses the filename or assumes where another job placed it. This avoids the class of build-versus-publish drift where CI validates one output and releases another—or expects an artifact in a location the producer never used.

The public package is deliberately CLI-only. Its allowlist contains compiled runtime files, the bundled deterministic-asset catalog, README, CHANGELOG, LICENSE, and package metadata. The development repository remains private and continues to own tests, fixtures, plans, and orchestration support.

## An installed runtime has different boundaries

Moving files into `packages/skills-autoresearch/` was only the first step. Installed code cannot assume that the caller is inside the harness checkout. Package-owned resources, such as the deterministic-asset catalog, resolve from the installed package. Project-owned resources, such as role instructions, resolve from the selected autoresearch project.

Both supported commands have executable entrypoints and consistent version reporting:

- `skills-autoresearch` provides the direct local CLI and recorded-response determinization path.
- `skills-autoresearch-flue` owns the Flue 2 runtime and role dispatch path.

Keeping the product boundary at Skills Autoresearch also avoids coupling users to a framework-specific utility. Flue remains the integrated runtime, while the package contract leaves room for alternative harnesses where the underlying feature does not technically require Flue.

## The clean-room proof

The proof begins by building and inspecting the authoritative tarball. It then creates a temporary workspace whose path contains spaces and copies only the self-contained release-notes project material needed for the run: configuration, evals, inputs, references, roles, seed skill, baseline, and the recorded determinization response.

The clean room first uses `pnpm deploy` in offline legacy mode to seed production dependency state from the repository's frozen lock. It then removes the deployed package's compiled output, catalog, README, CHANGELOG, and LICENSE; rewrites the deployment as a private consumer; and explicitly denies the two dependency build scripts pnpm identifies in this graph. This leaves the tested virtual store and lock state, but no package-owned product files that could substitute for the tarball.

Only then is the exact inspected archive added with pnpm in offline mode. Lifecycle scripts are disabled explicitly for both steps, and provider/model credentials are removed from every child-process environment. There is no network fallback, and the installed command shims are created from the tarball installation.

The proof then:

1. runs help and version through both installed binary shims;
2. runs the Flue smoke workflow with `--no-run-log`, asserts score `0.600`, and asserts zero model calls;
3. runs static recorded-response determinization without `--catalog-root`;
4. asserts one opportunity, three deterministic-asset recommendations, zero calls, the expected report, and exactly six output artifacts;
5. compares before-and-after SHA-256 snapshots of the skill, config, evals, input, reference, roles, and installed catalog.

Commands have timeouts and bounded captured output so an unexpected child process cannot grow memory indefinitely or hang CI. File reads with explicit limits are checked with `lstat` before allocation and checked again after reading.

Run the reusable proof directly:

```bash
pnpm run package:proof
```

Use JSON for automation or preserve the clean room for inspection:

```bash
pnpm run package:proof -- --json
pnpm run package:proof -- --keep
```

For a short narrated walkthrough:

```bash
pnpm run demo:phase-1 -- --keep
```

The demo prints the archive path, digest, size, content count, verified results, and retained workspace path. This makes the milestone visible: the commands are executing from an installed archive, not reaching back into the checkout.

## What Phase 1 does not claim

This phase does not publish the package to npm. It does not exercise a credential-backed researcher, producer, judge, or determinizer. Its evidence is intentionally credential-free: packaging integrity, installed runtime correctness, deterministic fixture behavior, and read-only boundaries.

## Next: a secure release path

Phase 2 will adapt the remaining Calavera release architecture: Changesets-managed version pull requests, pinned Fledgling release automation with dry-run and explicit approval, a protected GitHub `publish` environment, and token-free npm trusted publishing through OIDC.

The build/pack job will upload the already inspected tarball, and the publish job will download and release that exact artifact without rebuilding it. Contract checks will guard the pack, upload, and download paths; registry checks will make retries safe; prereleases will use the `next` tag before promotion to `latest`; and provenance, dist-tags, registry metadata, and a consumer install will be verified after publication.

That work remains a separate gate. Phase 1 gives it something trustworthy to release.
