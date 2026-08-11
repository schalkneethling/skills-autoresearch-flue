#!/usr/bin/env node
import { runFlueCommand } from "../flue-runner.js";

runFlueCommand()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  });
