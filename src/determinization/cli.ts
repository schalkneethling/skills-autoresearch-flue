import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createLogger } from "../logger.js";
import { AnthropicMessagesClient } from "../model-agent.js";
import { resumeDeterminizationReport, runDeterminizationReport } from "./run.js";
import { DirectModelDeterminizationTransport, StaticDeterminizationTransport } from "./transport.js";

export function determinizationUsage(): string {
  return [
    "Usage: skills-autoresearch determinize report [options]",
    "",
    "Options:",
    "  --project <dir>        Autoresearch project root. Defaults to current directory.",
    "  --skill <dir>          Explicit skill directory. Best scored iteration and origin skill are fallbacks.",
    "  --context-root <dir>   Optional external repository context (read-only allowlist).",
    "  --response-file <file> Use a recorded structured response without a model call.",
    "  --model-client <name>  Model client for analysis. Supported: anthropic.",
    "  --catalog-root <dir>   Deterministic-asset catalog root. Defaults to ./catalog/deterministic-assets.",
    "  --output <dir>         Artifact root. Defaults to workspace/determinization.",
    "  --resume               Re-render from validated immutable opportunities without a model call.",
    "  --json                 Print the structured result as JSON.",
    "  -h, --help             Show this help.",
    "",
    "This command is read-only for the selected skill, context, and catalog. It never proposes, verifies, applies, or adopts assets."
  ].join("\n");
}

export async function runDeterminizationCli(argv: string[]): Promise<void> {
  if (argv[0] !== "report") throw new Error("Choose the determinize command: report. Use --help for usage.");
  const parsed = parseArgs({
    args: argv.slice(1),
    options: {
      project: { type: "string" },
      skill: { type: "string" },
      "context-root": { type: "string" },
      "response-file": { type: "string" },
      "model-client": { type: "string" },
      "catalog-root": { type: "string" },
      output: { type: "string" },
      resume: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (parsed.values.help) {
    createLogger().write("log", determinizationUsage());
    return;
  }
  if (parsed.values["model-client"] && parsed.values["model-client"] !== "anthropic") {
    throw new Error(`Unsupported determinizer model client: ${parsed.values["model-client"]}`);
  }
  if (parsed.values["response-file"] && parsed.values["model-client"]) {
    throw new Error("Use either --response-file or --model-client, not both.");
  }
  if (parsed.values.resume && (parsed.values["response-file"] || parsed.values["model-client"])) {
    throw new Error("--resume reuses canonical artifacts and cannot be combined with a model or response file.");
  }
  const transport = parsed.values["response-file"]
    ? new StaticDeterminizationTransport(
        JSON.parse(await readFile(resolve(parsed.values["response-file"]), "utf8")) as unknown
      )
    : parsed.values.resume
      ? undefined
      : new DirectModelDeterminizationTransport(new AnthropicMessagesClient());
  const logger = createLogger();
  if (!parsed.values.json) {
    const plannedCalls = transport?.makesModelCall ? 1 : 0;
    logger.write("log", `Determinizer model call preview: ${plannedCalls} planned call(s).`);
  }
  const common = {
    projectRoot: resolve(parsed.values.project ?? process.cwd()),
    ...(parsed.values.skill && { skillDir: parsed.values.skill }),
    ...(parsed.values["context-root"] && { contextRoot: parsed.values["context-root"] }),
    ...(parsed.values["catalog-root"] && { catalogRoot: parsed.values["catalog-root"] }),
    ...(parsed.values.output && { outputRoot: parsed.values.output })
  };
  const result = parsed.values.resume
    ? await resumeDeterminizationReport(common)
    : await runDeterminizationReport({ ...common, transport: transport! });
  if (parsed.values.json) {
    logger.write("log", JSON.stringify(result, null, 2));
    return;
  }
  logger.write("log", `Determinization report: ${resolve(result.paths.report)}`);
  logger.write(
    "log",
    `Suggested opportunities: ${result.opportunityCount}; deterministic assets: ${result.recommendationCount}; model calls: ${result.cost.actualCalls}.`
  );
  if (result.cost.costUsd !== undefined)
    logger.write("log", `Observed determinizer cost: $${result.cost.costUsd.toFixed(4)}`);
}
