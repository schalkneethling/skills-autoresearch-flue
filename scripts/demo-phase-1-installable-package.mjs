#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runCleanRoomPackageProof } from "./clean-room-package-proof.mjs";

const HELP = `Demonstrate the Phase 1 installable package milestone.

Usage:
  node scripts/demo-phase-1-installable-package.mjs [--keep]

Options:
  --keep  Preserve the clean-room workspace for live inspection.
  --help  Show this help.
`;

async function main(args) {
  if (args.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const unknown = args.filter((argument) => argument !== "--keep");
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(", ")}`);

  process.stdout.write(
    [
      "Phase 1 demo — from repository-only alpha to an installable CLI",
      "",
      "This demo treats the inspected tarball as the product evidence. It installs that exact",
      "artifact offline in a path containing spaces, exercises both installed commands, and",
      "proves the project inputs and bundled deterministic catalog remain unchanged.",
      ""
    ].join("\n")
  );

  const result = await runCleanRoomPackageProof({
    keep: args.includes("--keep"),
    onProgress: (message) => process.stdout.write(`→ ${message}\n`)
  });

  process.stdout.write(
    [
      "",
      "Demo result",
      `  Package: ${result.packageName}@${result.version}`,
      `  Archive: ${result.archive.path}`,
      `  SHA-256: ${result.archive.sha256}`,
      `  Size: ${result.archive.size} bytes`,
      `  Contents: ${result.archive.fileCount} files`,
      `  Flue smoke: ${result.smoke.score.toFixed(3)} score, ${result.smoke.modelCalls} model calls`,
      `  Determinization: ${result.determinization.opportunities} opportunity, ${result.determinization.recommendations} recommendations, ${result.determinization.modelCalls} model calls`,
      `  Read-only inputs: ${result.readOnlyInputsUnchanged ? "byte-identical" : "changed"}`,
      `  Workspace: ${result.workspace.path} (${result.workspace.preserved ? "preserved" : "cleaned"})`,
      "",
      "Phase 1 establishes a trustworthy installable artifact. Registry publication and",
      "credential-backed model validation remain deliberately outside this demo."
    ].join("\n") + "\n"
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    if (error?.cleanRoomWorkspace) process.stderr.write(`Workspace preserved: ${error.cleanRoomWorkspace}\n`);
    process.exitCode = 1;
  });
}
