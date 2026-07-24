#!/usr/bin/env node
import { spawn } from "node:child_process";
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { FlueWorkflowResult } from "./flue-harness.js";
import { createRunLog, RunLog } from "./run-log.js";

export type RunnerMode = "smoke" | "research";

export type RunnerOptions = {
  verbose: boolean;
  writeRunLog: boolean;
  payload: Record<string, unknown>;
  help?: boolean;
};

const QUIET_STDOUT_MAX_CHARS = 1_048_576;

function usage(): string {
  return [
    "Usage:",
    "  skills-autoresearch-flue smoke [options]",
    "  skills-autoresearch-flue research [options]",
    "  skills-autoresearch-flue --payload <json> [options]",
    "",
    "Config-driven options:",
    "  --project <dir>         Project root. Defaults to current directory.",
    "  --seed-skill <dir>      Override config.json origin_skill for this run.",
    "  --guidance-skill <dir>  Override config.json guidance_skill for this run.",
    "  --session <name>        Override the derived project-mode session name.",
    "  --resume                Resume validated artifacts from an interrupted run.",
    "  --with-cleanup          Remove generated research artifacts before a fresh run.",
    "  --force-research        Research even when the baseline reaches target_score.",
    "  --budget-usd <amount>   Override config.json budget_usd for this run.",
    "",
    "General options:",
    "  --payload <json>        Advanced: pass a complete Flue payload directly.",
    "  --verbose               Print the complete Flue event stream.",
    "  --no-run-log            Do not write the complete local run log.",
    "  -h, --help              Show this help."
  ].join("\n");
}

export async function runFlueCommand(argv = process.argv.slice(2)): Promise<number> {
  const options = parseRunnerArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const projectRoot = resolve(String(options.payload.projectRoot ?? process.cwd()));
  const sessionId = String(options.payload.sessionId ?? "autoresearch");
  const runLog = options.writeRunLog ? createRunLog(projectRoot, sessionId) : undefined;
  const payload = {
    ...options.payload,
    projectRoot,
    verbose: options.verbose,
    writeRunLog: options.writeRunLog,
    ...(runLog ? { runLogPath: runLog.path } : {})
  };
  const flueArgs = buildFlueArgs(payload);

  runLog?.append("run-start", { command: "flue", args: flueArgs, projectRoot, sessionId });
  if (runLog) {
    process.stderr.write(`Run log: ${runLog.path}\n`);
  }

  const exitCode = await spawnFlue(flueArgs, options.verbose, runLog);
  runLog?.append("run-end", { exitCode });
  runLog?.close();
  return exitCode;
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
    values.session,
    values.resume,
    values["with-cleanup"],
    values["force-research"],
    values["budget-usd"]
  ].some((value) => value !== undefined);

  if (values.payload !== undefined) {
    if (positionals.length > 0 || configOptionsUsed) {
      throw new Error("Use either a smoke/research command or --payload, not both.");
    }
    return {
      verbose: values.verbose ?? false,
      writeRunLog: !(values["no-run-log"] ?? false),
      payload: parsePayload(values.payload)
    };
  }

  if (positionals.length !== 1 || !isRunnerMode(positionals[0])) {
    throw new Error("Choose a config-driven command: smoke or research. Use --help for usage.");
  }

  const mode = positionals[0];
  return {
    verbose: values.verbose ?? false,
    writeRunLog: !(values["no-run-log"] ?? false),
    payload: buildConfigDrivenPayload(mode, {
      projectRoot: values.project,
      seedSkillDir: values["seed-skill"],
      guidanceSkillDir: values["guidance-skill"],
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
    withBaseline: true,
    runResearch: mode === "research",
    sessionId: options.sessionId ?? `${basename(projectRoot)}-${mode}`,
    ...(options.seedSkillDir ? { seedSkillDir: options.seedSkillDir } : {}),
    ...(options.guidanceSkillDir ? { guidanceSkillDir: options.guidanceSkillDir } : {}),
    ...(options.resume ? { resume: true } : {}),
    ...(options.withCleanup ? { withCleanup: true } : {}),
    ...(options.forceResearch ? { forceResearch: true } : {}),
    ...(options.budgetUsd === undefined ? {} : { budgetUsd: options.budgetUsd })
  };
}

function isRunnerMode(value: string): value is RunnerMode {
  return value === "smoke" || value === "research";
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

export function buildFlueArgs(payload: Record<string, unknown>): string[] {
  return [
    "exec",
    "flue",
    "run",
    "autoresearch",
    "--target",
    "node",
    "--root",
    ".",
    "--payload",
    JSON.stringify(payload)
  ];
}

function spawnFlue(args: string[], verbose: boolean, runLog: RunLog | undefined): Promise<number> {
  return new Promise((resolveExit) => {
    const child = spawn("pnpm", args, { stdio: ["inherit", "pipe", "pipe"] });
    let quietStdout = "";
    let quietStdoutTruncated = false;
    let quietStderrBuffer = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      runLog?.append("process-output", { stream: "stdout", text });
      if (verbose) {
        process.stdout.write(text);
        return;
      }
      const buffered = appendQuietStdout(quietStdout, text);
      quietStdout = buffered.output;
      quietStdoutTruncated ||= buffered.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      runLog?.append("process-output", { stream: "stderr", text });
      if (verbose) {
        process.stderr.write(text);
        return;
      }
      quietStderrBuffer += text;
      const lines = quietStderrBuffer.split("\n");
      quietStderrBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (shouldPrintQuietLine(line)) {
          process.stderr.write(`${line}\n`);
        }
      }
    });
    child.on("error", (error) => {
      runLog?.append("process-error", { message: error.message });
      process.stderr.write(`Unable to start Flue: ${error.message}\n`);
      resolveExit(1);
    });
    child.on("close", (code) => {
      if (!verbose) {
        const summary = formatQuietResult(quietStdout, quietStdoutTruncated);
        if (summary) {
          process.stdout.write(`${summary}\n`);
        }
      }
      if (!verbose && quietStderrBuffer && shouldPrintQuietLine(quietStderrBuffer)) {
        process.stderr.write(`${quietStderrBuffer}\n`);
      }
      resolveExit(code ?? 1);
    });
  });
}

export function appendQuietStdout(current: string, chunk: string): { output: string; truncated: boolean } {
  if (chunk.length >= QUIET_STDOUT_MAX_CHARS) {
    return { output: chunk.slice(-QUIET_STDOUT_MAX_CHARS), truncated: true };
  }
  const combined = current + chunk;
  if (combined.length <= QUIET_STDOUT_MAX_CHARS) {
    return { output: combined, truncated: false };
  }
  return { output: combined.slice(-QUIET_STDOUT_MAX_CHARS), truncated: true };
}

export function formatQuietResult(output: string, truncated = false): string | undefined {
  const jsonStart = output.indexOf("{");
  if (jsonStart === -1) {
    return truncated
      ? "Run completed, but its structured result exceeded the 1 MiB quiet-mode buffer; inspect the run log or rerun with --verbose."
      : undefined;
  }
  try {
    const result = JSON.parse(output.slice(jsonStart)) as Partial<FlueWorkflowResult>;
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

export function shouldPrintQuietLine(line: string): boolean {
  return (
    line.startsWith("[flue] Running workflow:") ||
    line.startsWith("[flue] Run ID:") ||
    line.startsWith("[flue] tool:") ||
    line.startsWith("[flue] info:") ||
    line.startsWith("[flue] warn:") ||
    line.startsWith("[flue] error:") ||
    line.startsWith("[flue] ERROR") ||
    line.startsWith("[flue] Workflow error:") ||
    line === "[flue] Done."
  );
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
