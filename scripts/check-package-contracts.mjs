#!/usr/bin/env node
import process from "node:process";

import { validatePackageBuildContract } from "./package-artifact.mjs";

validatePackageBuildContract()
  .then(({ archivePath, expectedFiles, sourceManifest }) => {
    process.stdout.write(
      `Package contract valid: ${sourceManifest.name}@${sourceManifest.version}\n` +
        `Authoritative archive path: ${archivePath}\n` +
        `Expected packed inventory: ${expectedFiles.length} files\n`
    );
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
