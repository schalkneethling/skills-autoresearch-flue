#!/usr/bin/env node
import { parseArgs } from "node:util";
import { FileScoreAgent, SnapshotResearcher } from "./adapters.js";
import { createLogger, Logger, LogLevel } from "./logger.js";
import { AnthropicMessagesClient, ModelEvalAgent, ModelSkillResearcher } from "./model-agent.js";
import { orchestrateBaseline, OrchestrateOptions, RunEvent } from "./orchestrator.js";

interface CliOptions {
  projectRoot: string;
  withBaseline: boolean;
  runResearch: boolean;
  seedSkillDir?: string;
  scoreDir?: string;
  modelClient?: "anthropic";
  json: boolean;
}

function usage(): string {
  return [
    "Usage: skills-autoresearch [options]",
    "",
    "Options:",
    "  --project <dir>       Project root. Defaults to current directory.",
    "  --with-baseline       Import workspace/baseline instead of generating it.",
    "  --research            Run research iterations after baseline.",
    "  --seed-skill <dir>    Seed skill directory for research iterations.",
    "  --score-dir <dir>     Directory of file-backed EvalScore JSON files.",
    "  --model-client <name> Use a model client. Supported: anthropic.",
    "  --json                Print the full orchestrator result as JSON.",
    "  -h, --help            Show this help."
  ].join("\n");
}

export function parseCliArgs(argv: string[]): CliOptions {
  const parsed = parseArgs({
    args: argv,
    options: {
      project: { type: "string" },
      "with-baseline": { type: "boolean" },
      research: { type: "boolean" },
      "seed-skill": { type: "string" },
      "score-dir": { type: "string" },
      "model-client": { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });

  if (parsed.values.help) {
    createLogger().write("log", usage());
    process.exit(0);
  }

  const options: CliOptions = {
    projectRoot: parsed.values.project ?? process.cwd(),
    withBaseline: parsed.values["with-baseline"] ?? false,
    runResearch: parsed.values.research ?? false,
    seedSkillDir: parsed.values["seed-skill"],
    scoreDir: parsed.values["score-dir"],
    modelClient: parseModelClient(parsed.values["model-client"]),
    json: parsed.values.json ?? false
  };

  if (options.scoreDir && options.modelClient) {
    throw new Error("Use either --score-dir or --model-client, not both.");
  }
  if (!options.withBaseline && !options.scoreDir && !options.modelClient) {
    throw new Error("Generating a baseline requires --score-dir or --model-client anthropic.");
  }
  if (options.runResearch && !options.scoreDir && !options.modelClient) {
    throw new Error("Research iterations require --score-dir or --model-client anthropic.");
  }

  return options;
}

function parseModelClient(value: string | boolean | undefined): "anthropic" | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "anthropic") {
    return value;
  }
  throw new Error(`Unsupported model client: ${value}`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const logger = createLogger();
  const cli = parseCliArgs(argv);
  const modelClient = cli.modelClient === "anthropic" ? new AnthropicMessagesClient() : undefined;
  const options: OrchestrateOptions = {
    projectRoot: cli.projectRoot,
    withBaseline: cli.withBaseline,
    runResearch: cli.runResearch,
    seedSkillDir: cli.seedSkillDir,
    agent: modelClient
      ? new ModelEvalAgent(modelClient)
      : cli.scoreDir
        ? new FileScoreAgent({ scoreDir: cli.scoreDir })
        : undefined,
    researcher: modelClient
      ? new ModelSkillResearcher(modelClient)
      : cli.runResearch
        ? new SnapshotResearcher()
        : undefined
  };

  const result = await orchestrateBaseline(options);
  if (cli.json) {
    logger.write("log", JSON.stringify(result, null, 2));
    return;
  }

  writeEvents(result.events, logger);
  logger.write(
    "log",
    `Final score: ${result.aggregate.overall.normalizedScore.toFixed(3)} ` +
      `(${result.aggregate.overall.score}/${result.aggregate.overall.maxScore})`
  );
  if (result.bestIteration) {
    logger.write("log", `Best skill: ${result.bestIteration.skillDir}`);
  }
}

export function writeEvents(events: RunEvent[], logger: Logger): void {
  for (const event of events) {
    const formatted = formatEvent(event);
    logger.write(formatted.level, formatted.message);
  }
}

export function formatEvent(event: RunEvent): { level: LogLevel; message: string } {
  switch (event.type) {
    case "project-loaded":
      return { level: "debug", message: `Loaded project: ${event.root}` };
    case "baseline-imported":
      return { level: "log", message: `Imported baseline: ${event.scores} scores` };
    case "baseline-started":
      return { level: "log", message: `Generating baseline: ${event.evals} evals` };
    case "baseline-generated":
      return { level: "log", message: `Generated baseline: ${event.scores} scores` };
    case "aggregated":
      return { level: "log", message: `Aggregated score: ${event.aggregate.overall.normalizedScore.toFixed(3)}` };
    case "research-loop-ready":
      return {
        level: "debug",
        message: `Research loop ready: ${event.completedIterations}/${event.maxIterations} iterations complete`
      };
    case "iteration-started":
      return { level: "log", message: `Iteration ${event.iteration} started` };
    case "iteration-generated":
      return { level: "debug", message: `Iteration ${event.iteration} skill: ${event.candidateSkillDir}` };
    case "iteration-scored":
      return {
        level: "log",
        message: `Iteration ${event.iteration} score: ${event.aggregate.overall.normalizedScore.toFixed(3)}`
      };
    case "target-score-reached":
      return {
        level: "log",
        message: `Target reached at iteration ${event.iteration}: ${event.normalizedScore.toFixed(3)}`
      };
    case "max-iterations-reached":
      return { level: "warn", message: `Max iterations reached: ${event.completedIterations}/${event.maxIterations}` };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    createLogger().write("error", (error as Error).message);
    process.exitCode = 1;
  });
}
