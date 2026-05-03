import { createLogger, LogLevel, LogSink } from "../src/logger.js";
import { formatEvent, writeEvents } from "../src/cli.js";

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

test("createLogger routes messages by constant log level", () => {
  const { calls, target } = sink();
  const logger = createLogger(target);

  logger.write("log", "info");
  logger.write("warn", "careful");
  logger.write("debug", "trace");
  logger.write("error", "broken");

  expect(calls).toEqual([
    { level: "log", message: "info" },
    { level: "warn", message: "careful" },
    { level: "debug", message: "trace" },
    { level: "error", message: "broken" }
  ]);
});

test("writeEvents uses the severity returned by formatEvent", () => {
  const { calls, target } = sink();
  const logger = createLogger(target);

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
