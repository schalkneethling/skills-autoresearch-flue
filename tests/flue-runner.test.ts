import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RawDeterminizationAnalysis } from "../packages/skills-autoresearch/src/flue-agents.js";
import type { FlueRoleDispatcher, FlueRoleRuntime } from "../packages/skills-autoresearch/src/flue-runtime.js";
import {
  buildConfigDrivenPayload,
  formatFlueModelCallPreview,
  formatQuietResult,
  parseRunnerArgs,
  runFlueCommand,
  type FlueRunnerDependencies
} from "../packages/skills-autoresearch/src/flue-runner.js";
import { tempProject } from "./helpers.js";

const fixtureProject = fileURLToPath(new URL("../fixtures/projects/release-notes-alpha", import.meta.url));
const fixtureResponse = fileURLToPath(
  new URL("../fixtures/expected/determinization/release-notes-alpha/analysis-response.json", import.meta.url)
);
const catalogRoot = fileURLToPath(
  new URL("../packages/skills-autoresearch/catalog/deterministic-assets", import.meta.url)
);

test("Flue runner parses verbose and run-log opt-out flags without forwarding them", () => {
  expect(
    parseRunnerArgs(["--verbose", "--no-run-log", "--payload", '{"projectRoot":"/tmp/project","sessionId":"test"}'])
  ).toEqual({
    verbose: true,
    writeRunLog: false,
    payload: { projectRoot: "/tmp/project", sessionId: "test" }
  });
});

test("package scripts keep model-free smoke credential-free and remove the beta Flue build", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    scripts: Record<string, string>;
  };

  expect(packageJson.scripts.autoresearch).toBe(
    "pnpm run build && node packages/skills-autoresearch/dist/flue-runner.js"
  );
  expect(packageJson.scripts["alpha:smoke"]).toContain("pnpm run autoresearch");
  expect(packageJson.scripts["alpha:research"]).toContain("varlock run --");
  expect(packageJson.scripts["flue:build"]).toBeUndefined();
});

test("Flue runner builds config-driven smoke, research, and determinize payloads", () => {
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

  expect(buildConfigDrivenPayload("research")).toMatchObject({
    projectRoot: process.cwd(),
    withBaseline: true,
    runResearch: true,
    sessionId: `${basename(process.cwd())}-research`
  });
  expect(formatFlueModelCallPreview("determinize")).toBe("Determinizer model call preview: 1 planned call(s).");
  expect(formatFlueModelCallPreview("autoresearch")).toBeUndefined();
});

test("Flue runner rejects ambiguous modes and invalid concise overrides", () => {
  expect(() => parseRunnerArgs([])).toThrow(/smoke or research/u);
  expect(() => parseRunnerArgs(["unknown"])).toThrow(/smoke or research/u);
  expect(() => parseRunnerArgs(["research", "--payload", "{}"])).toThrow(/either/u);
  expect(() => parseRunnerArgs(["research", "--budget-usd=-1"])).toThrow(/non-negative/u);
  expect(() => parseRunnerArgs(["research", "--budget-usd", ""])).toThrow(/non-negative/u);
  expect(() => parseRunnerArgs(["--payload", "[]"])).toThrow(/JSON object/u);
  expect(() => parseRunnerArgs(["determinize", "--resume"])).toThrow(/autoresearch-only/u);
  expect(() => parseRunnerArgs(["determinize", "--budget-usd", "1"])).toThrow(/autoresearch-only/u);
});

test("model-free smoke bypasses the Flue runtime", async () => {
  const runtime = vi.fn(async () => {
    throw new Error("Smoke must not start Flue");
  }) as unknown as NonNullable<FlueRunnerDependencies["withRuntime"]>;
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  try {
    await expect(
      runFlueCommand(["smoke", "--project", fixtureProject, "--session", "runner-smoke", "--no-run-log"], {
        withRuntime: runtime
      })
    ).resolves.toBe(0);
    expect(runtime).not.toHaveBeenCalled();
    expect(stdout.mock.calls.flat().join("")).toContain("Run complete: score");
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

test("determinize runs through the owned Flue 2 runtime boundary", async () => {
  const outputRoot = await tempProject("det-flue-runner-");
  const response = JSON.parse(readFileSync(fixtureResponse, "utf8")) as RawDeterminizationAnalysis;
  const determinize = vi.fn<FlueRoleDispatcher["determinize"]>(async ({ prompt, model }) => ({
    data: response,
    text: "submitted",
    usage: { inputTokens: 120, outputTokens: 30, cacheCreationInputTokens: 10, cacheReadInputTokens: 20 },
    costUsd: 0.0033,
    instanceId: `${model}:${prompt.length}`,
    submissionId: "determinization-submission"
  }));
  const runtime = createRuntime({ determinize });
  let starts = 0;
  const withRuntime: NonNullable<FlueRunnerDependencies["withRuntime"]> = async (run) => {
    starts++;
    return run(runtime);
  };
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubEnv("FLUE_MODEL", "anthropic/claude-haiku-4-5");

  try {
    await expect(
      runFlueCommand(
        [
          "determinize",
          "--project",
          fixtureProject,
          "--catalog-root",
          catalogRoot,
          "--output",
          outputRoot,
          "--session",
          "runner-determinize",
          "--no-run-log"
        ],
        { withRuntime }
      )
    ).resolves.toBe(0);

    expect(starts).toBe(1);
    expect(determinize).toHaveBeenCalledOnce();
    expect(determinize).toHaveBeenCalledWith({
      prompt: expect.any(String),
      model: "anthropic/claude-haiku-4-5"
    });
    expect(await readFile(join(outputRoot, "report.md"), "utf8")).toContain("# Determinization opportunity report");
    expect(stdout.mock.calls.flat().join("")).toContain(`Determinization report: ${join(outputRoot, "report.md")}`);
  } finally {
    vi.unstubAllEnvs();
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

test.each(["openai/gpt-5", "anthropic/", "anthropic/claude/extra", "anthropic/claude sonnet"])(
  "determinize rejects invalid model override %j before runtime startup",
  async (model) => {
    const runtime = vi.fn(async () => {
      throw new Error("Runtime must not start");
    }) as unknown as NonNullable<FlueRunnerDependencies["withRuntime"]>;
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.stubEnv("FLUE_MODEL", model);
    try {
      await expect(
        runFlueCommand(["determinize", "--project", fixtureProject, "--no-run-log"], {
          withRuntime: runtime
        })
      ).rejects.toThrow(/anthropic\/<non-empty-model>/u);
      expect(runtime).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      stderr.mockRestore();
    }
  }
);

test("quiet result formatting preserves autoresearch and determinization summaries", () => {
  expect(
    formatQuietResult(
      JSON.stringify({
        completedIterations: 2,
        normalizedScore: 0.9,
        bestSkillDir: "/tmp/project/workspace/iterations/2/skill",
        cost: { actual: { totalCalls: 8 } }
      })
    )
  ).toBe(
    "Run complete: score 0.900; iterations 2; model calls 8; best skill /tmp/project/workspace/iterations/2/skill"
  );

  expect(
    formatQuietResult(
      JSON.stringify({
        paths: { report: "/tmp/project/workspace/determinization/report.md" },
        opportunityCount: 2,
        recommendationCount: 3,
        cost: { actualCalls: 1, costUsd: 0.0042 }
      })
    )
  ).toBe(
    "Determinization report: /tmp/project/workspace/determinization/report.md; opportunities 2; " +
      "deterministic assets 3; model calls 1; observed cost $0.0042"
  );
});

function createRuntime(overrides: Partial<FlueRoleDispatcher>): FlueRoleRuntime {
  const unexpected = async () => {
    throw new Error("Unexpected role dispatch");
  };
  return {
    produce: overrides.produce ?? unexpected,
    judge: overrides.judge ?? unexpected,
    research: overrides.research ?? unexpected,
    determinize: overrides.determinize ?? unexpected,
    async stop() {}
  } as FlueRoleRuntime;
}
