import { readFile } from "node:fs/promises";
import { createLogger, LogLevel, LogSink } from "../src/logger.js";
import { formatEvent, writeEvents } from "../src/cli.js";
import { createRunLog } from "../src/run-log.js";
import { tempProject } from "./helpers.js";

function sink() {
  const calls: Array<{ level: LogLevel; message: unknown }> = [];
  const target: LogSink = {
    log(message) {
      calls.push({ level: "log", message });
    },
    warn(message) {
      calls.push({ level: "warn", message });
    },
    debug(message) {
      calls.push({ level: "debug", message });
    },
    error(message) {
      calls.push({ level: "error", message });
    }
  };
  return { calls, target };
}

test("createLogger keeps default output quiet and verbose output includes debug messages", () => {
  const { calls, target } = sink();
  const logger = createLogger(target);

  logger.write("log", "info");
  logger.write("warn", "careful");
  logger.write("debug", "trace");
  logger.write("error", "broken");

  expect(calls).toEqual([
    { level: "log", message: "info" },
    { level: "warn", message: "careful" },
    { level: "error", message: "broken" }
  ]);

  createLogger(target, { verbose: true }).write("debug", "verbose trace");
  expect(calls.at(-1)).toEqual({ level: "debug", message: "verbose trace" });
});

test("writeEvents uses the severity returned by formatEvent", () => {
  const { calls, target } = sink();
  const logger = createLogger(target, { verbose: true });

  writeEvents(
    [
      { type: "project-loaded", root: "/tmp/project" },
      { type: "max-iterations-reached", completedIterations: 3, maxIterations: 3 }
    ],
    logger
  );

  expect(calls).toEqual([
    { level: "debug", message: "Loaded project: /tmp/project" },
    { level: "warn", message: "Max iterations reached: 3/3" }
  ]);
});

test("formatEvent classifies target completion as a regular log", () => {
  expect(
    formatEvent({
      type: "target-score-reached",
      iteration: 2,
      normalizedScore: 0.9,
      targetScore: 0.8
    })
  ).toEqual({ level: "log", message: "Target reached at iteration 2: 0.900" });
});

test("formatEvent explains baseline target completion", () => {
  expect(
    formatEvent({
      type: "baseline-target-score-reached",
      normalizedScore: 0.95,
      targetScore: 0.8
    })
  ).toEqual({ level: "log", message: "Baseline reached target: 0.950 >= 0.800" });
});

test("formatEvent reports compact eval progress and artifact paths", () => {
  expect(
    formatEvent({
      type: "eval-completed",
      phase: "iteration",
      iteration: 2,
      evalId: "notes-001",
      index: 1,
      total: 3,
      outputDir: "/tmp/project/workspace/iterations/2/outputs/notes-001"
    })
  ).toEqual({
    level: "log",
    message: "Iteration 2: eval 1/3 complete (notes-001) → /tmp/project/workspace/iterations/2/outputs/notes-001"
  });
});

test("run logs append structured records without overwriting earlier entries", async () => {
  const root = await tempProject();
  const runLog = createRunLog(root, "test run");
  runLog.append("run-start", { value: 1 });
  const firstRecord = await readFile(runLog.path, "utf8");
  runLog.append("run-event", { value: 2 });
  runLog.close();

  const completedLog = await readFile(runLog.path, "utf8");
  expect(completedLog.startsWith(firstRecord)).toBe(true);
  expect(completedLog.length).toBeGreaterThan(firstRecord.length);
  const records = completedLog
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; data: { value: number } });
  expect(records.map(({ type, data }) => [type, data.value])).toEqual([
    ["run-start", 1],
    ["run-event", 2]
  ]);
});
