#!/usr/bin/env node
import { parseArgs } from "node:util";
import { FileScoreAgent, SnapshotResearcher } from "./adapters.js";
import { formatCallCounts } from "./cost.js";
import { createLogger, Logger, LogLevel } from "./logger.js";
import { AnthropicMessagesClient, ModelEvalAgent, ModelSkillResearcher } from "./model-agent.js";
import { orchestrateBaseline, OrchestrateOptions, RunEvent } from "./orchestrator.js";

interface CliOptions {
  projectRoot: string;
  withBaseline: boolean;
  runResearch: boolean;
  forceResearch: boolean;
  resume: boolean;
  seedSkillDir?: string;
  scoreDir?: string;
  modelClient?: "anthropic";
  budgetUsd?: number;
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
    "  --force-research      Run research even when the baseline already reaches target_score.",
    "  --resume              Continue from validated baseline and iteration artifacts.",
    "  --seed-skill <dir>    Seed skill directory for research iterations.",
    "  --score-dir <dir>     Directory of file-backed EvalScore JSON files.",
    "  --model-client <name> Use a model client. Supported: anthropic.",
    "  --budget-usd <amount> Stop before additional model calls once observed cost reaches this cap.",
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
      "force-research": { type: "boolean" },
      resume: { type: "boolean" },
      "seed-skill": { type: "string" },
      "score-dir": { type: "string" },
      "model-client": { type: "string" },
      "budget-usd": { type: "string" },
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
    forceResearch: parsed.values["force-research"] ?? false,
    resume: parsed.values.resume ?? false,
    seedSkillDir: parsed.values["seed-skill"],
    scoreDir: parsed.values["score-dir"],
    modelClient: parseModelClient(parsed.values["model-client"]),
    budgetUsd: parseBudgetUsd(parsed.values["budget-usd"]),
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

function parseBudgetUsd(value: string | boolean | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("--budget-usd must be a non-negative number.");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("--budget-usd must be a non-negative number.");
  }
  return parsed;
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
    forceResearch: cli.forceResearch,
    resume: cli.resume,
    seedSkillDir: cli.seedSkillDir,
    budgetUsd: cli.budgetUsd,
    modelBacked: Boolean(modelClient),
    onEvent: cli.json
      ? undefined
      : (event) => {
          const formatted = formatEvent(event);
          logger.write(formatted.level, formatted.message);
        },
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

  logger.write(
    "log",
    `Final score: ${result.aggregate.overall.normalizedScore.toFixed(3)} ` +
      `(${result.aggregate.overall.score}/${result.aggregate.overall.maxScore})`
  );
  logger.write("log", `Model calls: ${formatCallCounts(result.cost.actual.calls)}`);
  if (result.cost.actual.costUsd !== undefined) {
    logger.write("log", `Observed model cost: $${result.cost.actual.costUsd.toFixed(4)}`);
  }
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
    case "cost-preview":
      return {
        level: event.summary.planned.totalCalls > 20 ? "warn" : "log",
        message:
          `Model call preview: ${event.summary.planned.totalCalls} maximum planned call(s) ` +
          `across ${event.summary.planned.evalCount} eval(s), ` +
          `${event.summary.planned.maxIterations} max iteration(s), ` +
          `concurrency ${event.summary.planned.maxConcurrency}. ` +
          `By role: ${formatCallCounts(event.summary.planned.calls)}` +
          (event.summary.budgetUsd === undefined ? "" : `. Budget: $${event.summary.budgetUsd.toFixed(2)}`)
      };
    case "baseline-imported":
      return { level: "log", message: `Imported baseline: ${event.scores} scores` };
    case "baseline-started":
      return { level: "log", message: `Generating baseline: ${event.evals} evals` };
    case "baseline-generated":
      return { level: "log", message: `Generated baseline: ${event.scores} scores` };
    case "baseline-resumed":
      return {
        level: "log",
        message: `Resumed baseline: reused ${event.scores} score(s), ${event.remaining} remaining`
      };
    case "aggregated":
      return {
        level: "log",
        message: `Aggregated score: ${event.aggregate.overall.normalizedScore.toFixed(3)}`
      };
    case "research-loop-ready":
      return {
        level: "debug",
        message: `Research loop ready: ${event.completedIterations}/${event.maxIterations} iterations complete`
      };
    case "iteration-started":
      return { level: "log", message: `Iteration ${event.iteration} started` };
    case "iteration-generated":
      return {
        level: "debug",
        message: `Iteration ${event.iteration} skill: ${event.candidateSkillDir}`
      };
    case "iteration-research-resumed":
      return {
        level: "log",
        message: `Iteration ${event.iteration}: reused completed research`
      };
    case "eval-score-resumed":
      return {
        level: "log",
        message: `Iteration ${event.iteration}: reused score for ${event.evalId}`
      };
    case "eval-producer-resumed":
      return {
        level: "log",
        message: `Iteration ${event.iteration}: reused producer output for ${event.evalId}`
      };
    case "eval-judge-resumed":
      return {
        level: "log",
        message: `Iteration ${event.iteration}: recovered judge score for ${event.evalId}`
      };
    case "iteration-summary-rebuilt":
      return {
        level: "log",
        message: `Iteration ${event.iteration}: rebuilt summary from persisted scores`
      };
    case "iteration-scored":
      return {
        level: "log",
        message: `Iteration ${event.iteration} score: ${event.aggregate.overall.normalizedScore.toFixed(3)}`
      };
    case "baseline-target-score-reached":
      return {
        level: "log",
        message: `Baseline reached target: ${event.normalizedScore.toFixed(3)} >= ${event.targetScore.toFixed(3)}`
      };
    case "target-score-reached":
      return {
        level: "log",
        message: `Target reached at iteration ${event.iteration}: ${event.normalizedScore.toFixed(3)}`
      };
    case "target-score-blocked-by-regression":
      return {
        level: "warn",
        message: `Target score met at iteration ${event.iteration}, but ${event.regressions.length} eval(s) regressed from baseline`
      };
    case "max-iterations-reached":
      return {
        level: "warn",
        message: `Max iterations reached: ${event.completedIterations}/${event.maxIterations}`
      };
    case "budget-reached":
      return {
        level: "warn",
        message: `Budget reached after ${event.completedIterations} iteration(s): $${event.actualCostUsd.toFixed(4)} >= $${event.budgetUsd.toFixed(4)}`
      };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    createLogger().write("error", (error as Error).message);
    process.exitCode = 1;
  });
}
