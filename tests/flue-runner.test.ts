import type { FlueContext, FlueSession } from "@flue/runtime";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run as runDeterminizeWorkflow } from "../.flue/workflows/determinize.js";
import {
  appendQuietStdout,
  buildConfigDrivenPayload,
  buildFlueArgs,
  formatFlueModelCallPreview,
  formatQuietResult,
  parseRunnerArgs,
  shouldPrintQuietLine
} from "../src/flue-runner.js";
import { tempProject } from "./helpers.js";

const fixtureProject = fileURLToPath(new URL("../fixtures/projects/release-notes-alpha", import.meta.url));
const fixtureResponse = fileURLToPath(
  new URL("../fixtures/expected/determinization/release-notes-alpha/analysis-response.json", import.meta.url)
);
const catalogRoot = fileURLToPath(new URL("../catalog/deterministic-assets", import.meta.url));

test("Flue runner parses verbose and run-log opt-out flags without forwarding them", () => {
  expect(
    parseRunnerArgs(["--verbose", "--no-run-log", "--payload", '{"projectRoot":"/tmp/project","sessionId":"test"}'])
  ).toEqual({
    verbose: true,
    writeRunLog: false,
    payload: { projectRoot: "/tmp/project", sessionId: "test" }
  });
});

test("package scripts keep model-free smoke credential-free", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };

  expect(packageJson.scripts.autoresearch).toBe("pnpm run build && node dist/src/flue-runner.js");
  expect(packageJson.scripts["alpha:smoke"]).toContain("pnpm run autoresearch");
  expect(packageJson.scripts["alpha:research"]).toContain("varlock run --");
});

test("Flue runner builds a config-driven baseline smoke command", () => {
  expect(parseRunnerArgs(["--", "smoke", "--project", "/tmp/project"])).toEqual({
    verbose: false,
    writeRunLog: true,
    payload: {
      projectRoot: "/tmp/project",
      withBaseline: true,
      runResearch: false,
      sessionId: "project-smoke"
    }
  });
});

test("Flue runner builds a config-driven research command with concise overrides", () => {
  expect(
    parseRunnerArgs([
      "research",
      "--project",
      "/tmp/project",
      "--seed-skill",
      "/tmp/alternate-skill",
      "--guidance-skill",
      "/tmp/guidance",
      "--session",
      "retry",
      "--resume",
      "--force-research",
      "--budget-usd",
      "0.25"
    ])
  ).toEqual({
    verbose: false,
    writeRunLog: true,
    payload: {
      projectRoot: "/tmp/project",
      withBaseline: true,
      runResearch: true,
      sessionId: "retry",
      seedSkillDir: "/tmp/alternate-skill",
      guidanceSkillDir: "/tmp/guidance",
      resume: true,
      forceResearch: true,
      budgetUsd: 0.25
    }
  });
});

test("config-driven commands default to the current project and derive a stable session", () => {
  expect(buildConfigDrivenPayload("research")).toMatchObject({
    projectRoot: process.cwd(),
    withBaseline: true,
    runResearch: true,
    sessionId: `${basename(process.cwd())}-research`
  });
});

test("Flue runner builds the determinize workflow payload without autoresearch flags", () => {
  expect(
    parseRunnerArgs([
      "determinize",
      "--project",
      "/tmp/project",
      "--skill",
      "/tmp/skill",
      "--context-root",
      "/tmp/context",
      "--catalog-root",
      "/tmp/catalog",
      "--output",
      "/tmp/output"
    ])
  ).toEqual({
    verbose: false,
    writeRunLog: true,
    workflow: "determinize",
    payload: {
      projectRoot: "/tmp/project",
      sessionId: "project-determinize",
      skillDir: "/tmp/skill",
      contextRoot: "/tmp/context",
      catalogRoot: "/tmp/catalog",
      outputRoot: "/tmp/output"
    }
  });
  expect(buildFlueArgs({ projectRoot: "/tmp/project" }, "determinize")).toContain("determinize");
  expect(formatFlueModelCallPreview("determinize")).toBe("Determinizer model call preview: 1 planned call(s).");
  expect(formatFlueModelCallPreview("autoresearch")).toBeUndefined();
  expect(() => parseRunnerArgs(["determinize", "--resume"])).toThrow(/does not accept autoresearch-only/);
  expect(() => parseRunnerArgs(["determinize", "--budget-usd", "1"])).toThrow(/does not accept autoresearch-only/);
});

test("determinize workflow produces the report through a Flue session", async () => {
  const outputRoot = await tempProject("det-flue-workflow-");
  const response = JSON.parse(readFileSync(fixtureResponse, "utf8")) as unknown;
  const task = vi.fn(async () => ({
    data: response,
    usage: {
      input: 120,
      output: 30,
      cacheRead: 20,
      cacheWrite: 10,
      totalTokens: 180,
      cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 }
    },
    model: { provider: "anthropic", id: "claude-haiku-4-5" }
  }));
  const session = {
    task
  } as unknown as FlueSession;
  const sessionFactory = vi.fn(async () => session);
  const init = vi.fn(async () => ({ session: sessionFactory }));

  const result = await runDeterminizeWorkflow({
    init,
    payload: {
      projectRoot: fixtureProject,
      catalogRoot,
      outputRoot,
      sessionId: "workflow-test",
      model: "anthropic/claude-haiku-4-5"
    },
    env: {}
  } as unknown as FlueContext);

  expect(init).toHaveBeenCalledOnce();
  expect(sessionFactory).toHaveBeenCalledWith("workflow-test");
  expect(task).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ agent: "determinizer", model: "anthropic/claude-haiku-4-5" })
  );
  expect(result.paths.report).toBe(join(outputRoot, "report.md"));
  expect(result.cost).toMatchObject({
    model: { provider: "anthropic", name: "claude-haiku-4-5" },
    usage: {
      inputTokens: 120,
      outputTokens: 30,
      cacheCreationInputTokens: 10,
      cacheReadInputTokens: 20
    },
    costUsd: 0.0033
  });
  expect(await readFile(result.paths.report, "utf8")).toContain("# Determinization opportunity report");
});

test.each(["openai/gpt-5", "anthropic/", "anthropic/claude/extra", "anthropic/claude sonnet"])(
  "determinize workflow rejects invalid model override %j before initialization",
  async (model) => {
    const init = vi.fn();
    await expect(
      runDeterminizeWorkflow({ init, payload: { model }, env: {} } as unknown as FlueContext)
    ).rejects.toThrow(/anthropic\/<non-empty-model>/);
    expect(init).not.toHaveBeenCalled();
  }
);

test("determinize workflow rejects an invalid environment model override before initialization", async () => {
  const init = vi.fn();
  await expect(
    runDeterminizeWorkflow({ init, payload: {}, env: { FLUE_MODEL: "openai/gpt-5" } } as unknown as FlueContext)
  ).rejects.toThrow(/anthropic\/<non-empty-model>/);
  expect(init).not.toHaveBeenCalled();
});

test("Flue runner keeps direct payload invocation as an advanced path", () => {
  expect(parseRunnerArgs(["--payload", '{"projectRoot":"/tmp/project","runResearch":false}'])).toMatchObject({
    payload: { projectRoot: "/tmp/project", runResearch: false }
  });
});

test("Flue runner rejects ambiguous modes and invalid concise overrides", () => {
  expect(() => parseRunnerArgs([])).toThrow(/smoke or research/);
  expect(() => parseRunnerArgs(["unknown"])).toThrow(/smoke or research/);
  expect(() => parseRunnerArgs(["research", "--payload", "{}"])).toThrow(/either/);
  expect(() => parseRunnerArgs(["research", "--budget-usd=-1"])).toThrow(/non-negative/);
  expect(() => parseRunnerArgs(["research", "--budget-usd", ""])).toThrow(/non-negative/);
  expect(() => parseRunnerArgs(["research", "--budget-usd", "   "])).toThrow(/non-negative/);
  expect(() => parseRunnerArgs(["--payload", "[]"])).toThrow(/JSON object/);
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

test("quiet Flue output summarizes determinization results", () => {
  expect(
    formatQuietResult(
      JSON.stringify({
        paths: { report: "/tmp/project/workspace/determinization/report.md" },
        opportunityCount: 2,
        recommendationCount: 4,
        cost: { actualCalls: 1, costUsd: 0.0123 }
      })
    )
  ).toBe(
    "Determinization report: /tmp/project/workspace/determinization/report.md; opportunities 2; deterministic assets 4; model calls 1; observed cost $0.0123"
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
