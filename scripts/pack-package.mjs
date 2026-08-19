#!/usr/bin/env node
import process from "node:process";

import { packAuthoritativePackage } from "./package-artifact.mjs";

const HELP = `Pack and inspect the authoritative Skills Autoresearch archive.

Usage:
  node scripts/pack-package.mjs [--json]

Options:
  --json  Print a machine-readable artifact summary.
  --help  Show this help.
`;

async function main(args) {
  if (args.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const unknown = args.filter((argument) => argument !== "--json");
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(", ")}`);

  const result = await packAuthoritativePackage();
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      `Package: ${result.packageName}@${result.version}`,
      `Archive: ${result.path}`,
      `SHA-256: ${result.sha256}`,
      `Size: ${result.size} bytes`,
      `Contents: ${result.fileCount} files`,
      ...result.files.map((file) => `  ${file}`)
    ].join("\n") + "\n"
  );
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
