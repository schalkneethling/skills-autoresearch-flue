import {
  appendQuietStdout,
  buildFlueArgs,
  formatQuietResult,
  parseRunnerArgs,
  shouldPrintQuietLine
} from "../src/flue-runner.js";

test("Flue runner parses verbose and run-log opt-out flags without forwarding them", () => {
  expect(
    parseRunnerArgs(["--verbose", "--no-run-log", "--payload", '{"projectRoot":"/tmp/project","sessionId":"test"}'])
  ).toEqual({
    verbose: true,
    writeRunLog: false,
    payload: { projectRoot: "/tmp/project", sessionId: "test" }
  });
});

test("Flue runner emits exactly one canonical payload argument", () => {
  const args = buildFlueArgs({ projectRoot: "/tmp/project", verbose: true });
  expect(args.filter((arg) => arg === "--payload")).toHaveLength(1);
  expect(JSON.parse(args.at(-1) ?? "")).toEqual({ projectRoot: "/tmp/project", verbose: true });
});

test.each([
  ["[flue] tool:start  write  /tmp/result.md", true],
  ["[flue] info: Iteration 1: eval 1/2 started", true],
  ["[flue] Run ID: workflow:autoresearch:123", true],
  ["[flue] thinking:start", false],
  ["  full generated output contents", false],
  ["  hidden chain of thought", false]
])("quiet Flue output filters content-bearing lines", (line, expected) => {
  expect(shouldPrintQuietLine(line)).toBe(expected);
});

test("quiet Flue output replaces the full result with a compact summary", () => {
  expect(
    formatQuietResult(
      `[flue] build output\n${JSON.stringify({
        completedIterations: 2,
        normalizedScore: 0.9,
        bestSkillDir: "/tmp/project/workspace/iterations/2/skill",
        cost: { actual: { totalCalls: 8 } }
      })}\n`
    )
  ).toBe(
    "Run complete: score 0.900; iterations 2; model calls 8; best skill /tmp/project/workspace/iterations/2/skill"
  );
});

test("quiet Flue output keeps a fixed-size tail that can still contain the final result", () => {
  const resultJson = JSON.stringify({
    completedIterations: 1,
    normalizedScore: 0.8,
    cost: { actual: { totalCalls: 5 } }
  });
  const buffered = appendQuietStdout("x".repeat(1_048_570), resultJson);

  expect(buffered.truncated).toBe(true);
  expect(buffered.output.length).toBeLessThanOrEqual(1_048_576);
  expect(formatQuietResult(buffered.output, buffered.truncated)).toBe(
    "Run complete: score 0.800; iterations 1; model calls 5"
  );
});

test("quiet Flue output explains when a truncated result cannot be parsed", () => {
  expect(formatQuietResult("result tail without JSON", true)).toBe(
    "Run completed, but its structured result exceeded the 1 MiB quiet-mode buffer; inspect the run log or rerun with --verbose."
  );
});
