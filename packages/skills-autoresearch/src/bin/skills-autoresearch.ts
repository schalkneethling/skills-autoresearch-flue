#!/usr/bin/env node
import { main } from "../cli.js";
import { createLogger } from "../logger.js";

main().catch((error: unknown) => {
  createLogger().write("error", (error as Error).message);
  process.exitCode = 1;
});
