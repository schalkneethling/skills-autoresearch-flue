#!/usr/bin/env node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { FlueWorkflowResult } from "./flue-harness.js";
import { createRunLog, RunLog } from "./run-log.js";

type RunnerOptions = {
  verbose: boolean;
  writeRunLog: boolean;
  payload: Record<string, unknown>;
};

const QUIET_STDOUT_MAX_CHARS = 1_048_576;

export async function runFlueCommand(argv = process.argv.slice(2)): Promise<number> {
  const options = parseRunnerArgs(argv);
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
  const { values } = parseArgs({
    args: argv,
    options: {
      verbose: { type: "boolean" },
      "no-run-log": { type: "boolean" },
      payload: { type: "string" }
    },
    strict: true,
    allowPositionals: false
  });

  return {
    verbose: values.verbose ?? false,
    writeRunLog: !(values["no-run-log"] ?? false),
    payload: JSON.parse(values.payload ?? "{}") as Record<string, unknown>
  };
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
