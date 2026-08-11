#!/usr/bin/env node
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { formatEvent } from "./cli.js";
import { runDeterminizationReport } from "./determinization/run.js";
import { FlueDeterminizationTransport } from "./determinization/transport.js";
import { runFlueAutoresearch, type FlueWorkflowResult } from "./flue-harness.js";
import { withFlueRoleRuntime } from "./flue-runtime.js";
import { orchestrateBaseline, type OrchestratorResult, type RunEvent } from "./orchestrator.js";
import { createRunLog } from "./run-log.js";
import { normalizeRunOptions } from "./run-options.js";

export type RunnerMode = "smoke" | "research" | "determinize";

export type RunnerOptions = {
  verbose: boolean;
  writeRunLog: boolean;
  payload: Record<string, unknown>;
  workflow?: "autoresearch" | "determinize";
  help?: boolean;
};

export interface FlueRunnerDependencies {
  withRuntime?: typeof withFlueRoleRuntime;
}

function usage(): string {
  return [
    "Usage:",
    "  skills-autoresearch-flue smoke [options]",
    "  skills-autoresearch-flue research [options]",
    "  skills-autoresearch-flue determinize [options]",
    "  skills-autoresearch-flue --payload <json> [options]",
    "",
    "Config-driven options:",
    "  --project <dir>         Project root. Defaults to current directory.",
    "  --seed-skill <dir>      Override config.json origin_skill for this run.",
    "  --guidance-skill <dir>  Override config.json guidance_skill for this run.",
    "  --skill <dir>           Explicit skill directory for determinize.",
    "  --context-root <dir>    Optional external read-only context for determinize.",
    "  --catalog-root <dir>    Deterministic-asset catalog root.",
    "  --output <dir>          Determinization artifact root.",
    "  --session <name>        Override the derived project-mode session name.",
    "  --resume                Resume validated artifacts from an interrupted run.",
    "  --with-cleanup          Remove generated research artifacts before a fresh run.",
    "  --force-research        Research even when the baseline reaches target_score.",
    "  --budget-usd <amount>   Override config.json budget_usd for this run.",
    "",
    "General options:",
    "  --payload <json>        Advanced: pass a complete Flue payload directly.",
    "  --verbose               Print debug events and the structured result.",
    "  --no-run-log            Do not write the local event and result log.",
    "  -h, --help              Show this help."
  ].join("\n");
}

export async function runFlueCommand(
  argv = process.argv.slice(2),
  dependencies: FlueRunnerDependencies = {}
): Promise<number> {
  const options = parseRunnerArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const projectRoot = resolve(optionalString(options.payload, "projectRoot") ?? process.cwd());
  const sessionId = optionalString(options.payload, "sessionId") ?? "autoresearch";
  const runLog = options.writeRunLog ? createRunLog(projectRoot, sessionId) : undefined;
  const payload = {
    ...options.payload,
    projectRoot,
    verbose: options.verbose,
    writeRunLog: options.writeRunLog,
    ...(runLog ? { runLogPath: runLog.path } : {})
  };
  const workflow = options.workflow ?? "autoresearch";
  const runWithRuntime = dependencies.withRuntime ?? withFlueRoleRuntime;
  runLog?.append("run-start", { command: "skills-autoresearch-flue", workflow, payload, projectRoot, sessionId });
  if (runLog) {
    process.stderr.write(`Run log: ${runLog.path}\n`);
  }
  const modelCallPreview = formatFlueModelCallPreview(workflow);
  if (modelCallPreview) process.stderr.write(`${modelCallPreview}\n`);

  try {
    const result =
      workflow === "determinize"
        ? await runDeterminizePayload(payload, runWithRuntime)
        : await runAutoresearchPayload(payload, options.verbose, runLog, runWithRuntime);
    runLog?.append("run-result", result);
    if (options.verbose) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const summary = formatQuietResult(JSON.stringify(result));
      if (summary) process.stdout.write(`${summary}\n`);
    }
    runLog?.append("run-end", { exitCode: 0 });
    return 0;
  } catch (error) {
    runLog?.append("run-error", { message: (error as Error).message, stack: (error as Error).stack });
    runLog?.append("run-end", { exitCode: 1 });
    throw error;
  } finally {
    runLog?.close();
  }
}

async function runAutoresearchPayload(
  payload: Record<string, unknown>,
  verbose: boolean,
  runLog: ReturnType<typeof createRunLog> | undefined,
  runWithRuntime: typeof withFlueRoleRuntime
): Promise<FlueWorkflowResult> {
  const runOptions = normalizeRunOptions({
    projectRoot: optionalString(payload, "projectRoot"),
    withBaseline: optionalBoolean(payload, "withBaseline"),
    runResearch: optionalBoolean(payload, "runResearch"),
    forceResearch: optionalBoolean(payload, "forceResearch"),
    resume: optionalBoolean(payload, "resume"),
    withCleanup: optionalBoolean(payload, "withCleanup"),
    seedSkillDir: optionalString(payload, "seedSkillDir"),
    guidanceSkillDir: optionalString(payload, "guidanceSkillDir"),
    budgetUsd: optionalNumber(payload, "budgetUsd")
  });
  const onEvent = (event: RunEvent) => writeRunEvent(event, verbose, runLog);

  if (runOptions.withBaseline && !runOptions.runResearch) {
    return toFlueWorkflowResult(
      await orchestrateBaseline({ ...runOptions, modelBacked: true, onEvent }),
      optionalString(payload, "runLogPath")
    );
  }

  return runWithRuntime(async (dispatcher) => {
    const result = await runFlueAutoresearch({ dispatcher, ...runOptions, onEvent });
    return toFlueWorkflowResult(result, optionalString(payload, "runLogPath"));
  });
}

async function runDeterminizePayload(payload: Record<string, unknown>, runWithRuntime: typeof withFlueRoleRuntime) {
  const rawModel = optionalString(payload, "model") ?? process.env.FLUE_MODEL;
  const modelOverride = parseDeterminizationModel(rawModel);
  const projectRoot = resolve(optionalString(payload, "projectRoot") ?? process.cwd());
  const skillDir = optionalString(payload, "skillDir");
  const contextRoot = optionalString(payload, "contextRoot");
  const catalogRoot = optionalString(payload, "catalogRoot");
  const outputRoot = optionalString(payload, "outputRoot");
  return runWithRuntime((dispatcher) =>
    runDeterminizationReport({
      projectRoot,
      transport: new FlueDeterminizationTransport(dispatcher),
      ...(modelOverride && { modelOverride }),
      ...(skillDir && { skillDir }),
      ...(contextRoot && { contextRoot }),
      ...(catalogRoot && { catalogRoot }),
      ...(outputRoot && { outputRoot })
    })
  );
}

function parseDeterminizationModel(model: string | undefined): { provider: "anthropic"; name: string } | undefined {
  if (model === undefined) return undefined;
  const match = /^anthropic\/([^/\s]+)$/u.exec(model);
  if (!match) throw new Error("Determinization model must use the format anthropic/<non-empty-model>");
  return { provider: "anthropic", name: match[1] };
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string.`);
  return value;
}

function optionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean.`);
  return value;
}

function optionalNumber(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") throw new Error(`${key} must be a number.`);
  return value;
}

function toFlueWorkflowResult(result: OrchestratorResult, runLogPath?: string): FlueWorkflowResult {
  return {
    completedIterations: result.completedIterations,
    normalizedScore: result.aggregate.overall.normalizedScore,
    bestSkillDir: result.bestIteration?.skillDir,
    ...(runLogPath && { runLogPath }),
    cost: result.cost,
    events: result.events.map((event) => event.type)
  };
}

function writeRunEvent(event: RunEvent, verbose: boolean, runLog: ReturnType<typeof createRunLog> | undefined): void {
  runLog?.append("run-event", event);
  const formatted = formatEvent(event);
  if (formatted.level === "debug" && !verbose) return;
  const prefix = formatted.level === "warn" || formatted.level === "error" ? `${formatted.level}: ` : "";
  process.stderr.write(`${prefix}${formatted.message}\n`);
}

export function parseRunnerArgs(argv: string[]): RunnerOptions {
  const runnerArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const { values, positionals } = parseArgs({
    args: runnerArgv,
    options: {
      verbose: { type: "boolean" },
      "no-run-log": { type: "boolean" },
      payload: { type: "string" },
      project: { type: "string" },
      "seed-skill": { type: "string" },
      "guidance-skill": { type: "string" },
      skill: { type: "string" },
      "context-root": { type: "string" },
      "catalog-root": { type: "string" },
      output: { type: "string" },
      session: { type: "string" },
      resume: { type: "boolean" },
      "with-cleanup": { type: "boolean" },
      "force-research": { type: "boolean" },
      "budget-usd": { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: true
  });

  if (values.help) {
    return {
      verbose: values.verbose ?? false,
      writeRunLog: !(values["no-run-log"] ?? false),
      payload: {},
      help: true
    };
  }

  const configOptionsUsed = [
    values.project,
    values["seed-skill"],
    values["guidance-skill"],
    values.skill,
    values["context-root"],
    values["catalog-root"],
    values.output,
    values.session,
    values.resume,
    values["with-cleanup"],
    values["force-research"],
    values["budget-usd"]
  ].some((value) => value !== undefined);

  if (values.payload !== undefined) {
    if (positionals.length > 0 || configOptionsUsed) {
      throw new Error("Use either a config-driven command or --payload, not both.");
    }
    return {
      verbose: values.verbose ?? false,
      writeRunLog: !(values["no-run-log"] ?? false),
      payload: parsePayload(values.payload)
    };
  }

  if (positionals.length !== 1 || !isRunnerMode(positionals[0])) {
    throw new Error("Choose a config-driven command: smoke or research, or determinize. Use --help for usage.");
  }

  const mode = positionals[0];
  if (
    mode === "determinize" &&
    [
      values["seed-skill"],
      values["guidance-skill"],
      values.resume,
      values["with-cleanup"],
      values["force-research"],
      values["budget-usd"]
    ].some((value) => value !== undefined && value !== false)
  ) {
    throw new Error(
      "Determinize does not accept autoresearch-only seed, guidance, resume, cleanup, force, or budget options."
    );
  }
  return {
    verbose: values.verbose ?? false,
    writeRunLog: !(values["no-run-log"] ?? false),
    ...(mode === "determinize" ? { workflow: "determinize" as const } : {}),
    payload: buildConfigDrivenPayload(mode, {
      projectRoot: values.project,
      seedSkillDir: values["seed-skill"],
      guidanceSkillDir: values["guidance-skill"],
      skillDir: values.skill,
      contextRoot: values["context-root"],
      catalogRoot: values["catalog-root"],
      outputRoot: values.output,
      sessionId: values.session,
      resume: values.resume,
      withCleanup: values["with-cleanup"],
      forceResearch: values["force-research"],
      budgetUsd: parseBudgetUsd(values["budget-usd"])
    })
  };
}

export function buildConfigDrivenPayload(
  mode: RunnerMode,
  options: {
    projectRoot?: string;
    seedSkillDir?: string;
    guidanceSkillDir?: string;
    skillDir?: string;
    contextRoot?: string;
    catalogRoot?: string;
    outputRoot?: string;
    sessionId?: string;
    resume?: boolean;
    withCleanup?: boolean;
    forceResearch?: boolean;
    budgetUsd?: number;
  } = {}
): Record<string, unknown> {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  return {
    projectRoot,
    ...(mode === "determinize" ? {} : { withBaseline: true, runResearch: mode === "research" }),
    sessionId: options.sessionId ?? `${basename(projectRoot)}-${mode}`,
    ...(options.seedSkillDir ? { seedSkillDir: options.seedSkillDir } : {}),
    ...(options.guidanceSkillDir ? { guidanceSkillDir: options.guidanceSkillDir } : {}),
    ...(options.skillDir ? { skillDir: options.skillDir } : {}),
    ...(options.contextRoot ? { contextRoot: options.contextRoot } : {}),
    ...(options.catalogRoot ? { catalogRoot: options.catalogRoot } : {}),
    ...(options.outputRoot ? { outputRoot: options.outputRoot } : {}),
    ...(options.resume ? { resume: true } : {}),
    ...(options.withCleanup ? { withCleanup: true } : {}),
    ...(options.forceResearch ? { forceResearch: true } : {}),
    ...(options.budgetUsd === undefined ? {} : { budgetUsd: options.budgetUsd })
  };
}

function isRunnerMode(value: string): value is RunnerMode {
  return value === "smoke" || value === "research" || value === "determinize";
}

function parsePayload(value: string): Record<string, unknown> {
  const payload = JSON.parse(value) as unknown;
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error("--payload must be a JSON object.");
  }
  return payload as Record<string, unknown>;
}

function parseBudgetUsd(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.trim() === "") {
    throw new Error("--budget-usd must be a non-negative number.");
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("--budget-usd must be a non-negative number.");
  }
  return parsed;
}

export function formatFlueModelCallPreview(workflow: "autoresearch" | "determinize"): string | undefined {
  return workflow === "determinize" ? "Determinizer model call preview: 1 planned call(s)." : undefined;
}

export function formatQuietResult(output: string, truncated = false): string | undefined {
  const jsonStart = output.indexOf("{");
  if (jsonStart === -1) {
    return truncated
      ? "Run completed, but its structured result exceeded the 1 MiB quiet-mode buffer; inspect the run log or rerun with --verbose."
      : undefined;
  }
  try {
    const result = JSON.parse(output.slice(jsonStart)) as Partial<FlueWorkflowResult> & {
      paths?: { report?: string };
      opportunityCount?: number;
      recommendationCount?: number;
    };
    if (result.paths?.report) {
      const determinizationCost = (result as unknown as { cost?: { actualCalls?: number; costUsd?: number } }).cost;
      return (
        `Determinization report: ${result.paths.report}; opportunities ${result.opportunityCount ?? "unknown"}; ` +
        `deterministic assets ${result.recommendationCount ?? "unknown"}; model calls ${determinizationCost?.actualCalls ?? "unknown"}` +
        (determinizationCost?.costUsd === undefined ? "" : `; observed cost $${determinizationCost.costUsd.toFixed(4)}`)
      );
    }
    const score = result.normalizedScore?.toFixed(3) ?? "unknown";
    const iterations = result.completedIterations ?? "unknown";
    const calls = result.cost?.actual?.totalCalls ?? "unknown";
    return (
      `Run complete: score ${score}; iterations ${iterations}; model calls ${calls}` +
      (result.bestSkillDir ? `; best skill ${result.bestSkillDir}` : "")
    );
  } catch {
    return truncated
      ? "Run completed, but its structured result exceeded the 1 MiB quiet-mode buffer; inspect the run log or rerun with --verbose."
      : undefined;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runFlueCommand()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
