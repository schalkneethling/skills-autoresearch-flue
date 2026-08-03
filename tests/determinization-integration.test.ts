import type { FlueSession } from "@flue/runtime";
import { chmod, mkdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { main } from "../src/cli.js";
import { runDeterminizationReport } from "../src/determinization/run.js";
import {
  DirectModelDeterminizationTransport,
  FlueDeterminizationTransport,
  StaticDeterminizationTransport,
  type DeterminizationTransport
} from "../src/determinization/transport.js";
import type { ModelClient } from "../src/model-agent.js";
import { tempProject, writeFixture, syntheticConfig, syntheticEvals } from "./helpers.js";

const fixtureProject = resolve("fixtures/projects/release-notes-alpha");
const fixtureResponse = resolve("fixtures/expected/determinization/release-notes-alpha/analysis-response.json");
const fixtureReport = resolve("fixtures/expected/determinization/release-notes-alpha/report.md");
const catalogRoot = resolve("catalog/deterministic-assets");

async function response() {
  return JSON.parse(await readFile(fixtureResponse, "utf8")) as unknown;
}

test("runs the release-notes fixture deterministically and preserves the read-only boundary", async () => {
  const output = await tempProject("det-integration-");
  const skillPath = join(fixtureProject, "seed-skill", "SKILL.md");
  const catalogPath = join(catalogRoot, "language.json");
  const before = await Promise.all([readFile(skillPath), readFile(catalogPath)]);
  const result = await runDeterminizationReport({
    projectRoot: fixtureProject,
    outputRoot: output,
    catalogRoot,
    transport: new StaticDeterminizationTransport(await response())
  });
  const report = await readFile(result.paths.report, "utf8");
  expect(result).toMatchObject({
    selectedSkillSource: "origin_skill",
    opportunityCount: 1,
    recommendationCount: 3,
    cost: { plannedCalls: 0, actualCalls: 0 }
  });
  expect(report).toContain("partially_deterministic");
  expect(report).toContain("LanguageTool may contribute");
  expect(report).toContain("Custom LanguageTool rules");
  expect(report).toContain("editorial judgment");
  expect(report).toContain("suggested and unverified");
  expect(report).toBe(await readFile(fixtureReport, "utf8"));
  const source = JSON.parse(await readFile(result.paths.source, "utf8")) as { inputs: Array<{ path: string }> };
  expect(source.inputs.map(({ path }) => path)).toEqual(
    expect.arrayContaining([
      "evaluation/CHANGELOG.md",
      "evaluation/notes-001/input/CHANGELOG.md",
      "evaluation/notes-001/task.md"
    ])
  );
  expect(await Promise.all([readFile(skillPath), readFile(catalogPath)])).toEqual(before);
});

test("counts model calls from the transport capability rather than its name", async () => {
  const recordedResponse = await response();
  const result = await runDeterminizationReport({
    projectRoot: fixtureProject,
    outputRoot: await tempProject("det-call-capability-"),
    catalogRoot,
    transport: {
      name: "custom-recording",
      makesModelCall: false,
      async analyze(request) {
        return { response: recordedResponse, transcript: { request, response: recordedResponse } };
      }
    }
  });

  expect(result.cost).toMatchObject({ plannedCalls: 0, actualCalls: 0 });
});

test("rejects a symlinked input root before invoking the transport", async () => {
  const links = await tempProject("det-symlink-root-");
  const linkedSkill = join(links, "linked-skill");
  await symlink(join(fixtureProject, "seed-skill"), linkedSkill);
  let calls = 0;
  await expect(
    runDeterminizationReport({
      projectRoot: fixtureProject,
      skillDir: linkedSkill,
      outputRoot: await tempProject("det-symlink-output-"),
      catalogRoot,
      transport: {
        name: "audit-spy",
        makesModelCall: false,
        async analyze(request) {
          calls += 1;
          const response = { schema_version: "1.0.0", opportunities: [] };
          return {
            response,
            transcript: { request, response }
          };
        }
      }
    })
  ).rejects.toThrow(/Symbolic links are not valid determinization/);
  expect(calls).toBe(0);
});

test("rejects output beneath a selected read-only root before invoking the transport", async () => {
  let calls = 0;
  await expect(
    runDeterminizationReport({
      projectRoot: fixtureProject,
      outputRoot: join(fixtureProject, "seed-skill", "generated-report"),
      catalogRoot,
      transport: {
        name: "audit-spy",
        makesModelCall: false,
        async analyze(request) {
          calls += 1;
          const response = { schema_version: "1.0.0", opportunities: [] };
          return { response, transcript: { request, response } };
        }
      }
    })
  ).rejects.toThrow(/must not be inside/);
  expect(calls).toBe(0);
});

test("rejects symlinked project and output roots before invoking the transport", async () => {
  const links = await tempProject("det-root-links-");
  const linkedProject = join(links, "project");
  const linkedOutput = join(links, "output");
  await symlink(fixtureProject, linkedProject);
  await symlink(await tempProject("det-real-output-"), linkedOutput);
  let calls = 0;
  const transport = {
    name: "audit-spy",
    makesModelCall: false,
    async analyze(request: Parameters<DeterminizationTransport["analyze"]>[0]) {
      calls += 1;
      const response = { schema_version: "1.0.0", opportunities: [] };
      return { response, transcript: { request, response } };
    }
  } satisfies DeterminizationTransport;
  await expect(
    runDeterminizationReport({ projectRoot: linkedProject, outputRoot: await tempProject(), catalogRoot, transport })
  ).rejects.toThrow(/Symbolic links are not valid determinization project roots/);
  await expect(
    runDeterminizationReport({ projectRoot: fixtureProject, outputRoot: linkedOutput, catalogRoot, transport })
  ).rejects.toThrow(/output root or nearest existing parent must not be a symlink/);
  expect(calls).toBe(0);
});

test("rejects an oversized input before attempting to read it", async () => {
  const root = await tempProject("det-oversized-input-");
  await writeFixture(root, syntheticConfig, syntheticEvals);
  await mkdir(join(root, "seed-skill"));
  await writeFile(join(root, "seed-skill", "SKILL.md"), "# Seed\n");
  const oversized = join(root, "evals", "oversized.txt");
  await writeFile(oversized, "");
  await truncate(oversized, 256 * 1024 + 1);
  await chmod(oversized, 0);
  try {
    await expect(
      runDeterminizationReport({
        projectRoot: root,
        outputRoot: await tempProject("det-oversized-output-"),
        catalogRoot,
        transport: new StaticDeterminizationTransport(await response())
      })
    ).rejects.toThrow(/Determinization input exceeds 256 KiB: .*oversized\.txt/);
  } finally {
    await chmod(oversized, 0o600);
  }
});

test("CLI prints an absolute inspectable path and resumes without a model call", async () => {
  const output = await tempProject("det-cli-");
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    await main([
      "determinize",
      "report",
      "--project",
      fixtureProject,
      "--response-file",
      fixtureResponse,
      "--catalog-root",
      catalogRoot,
      "--output",
      output
    ]);
    expect(log.mock.calls.flat().join("\n")).toContain(`Determinization report: ${join(output, "report.md")}`);
    expect(log.mock.calls.flat().join("\n")).toContain("model calls: 0");
    await rm(join(output, "report.md"));
    log.mockClear();
    await main([
      "determinize",
      "report",
      "--project",
      fixtureProject,
      "--resume",
      "--catalog-root",
      catalogRoot,
      "--output",
      output
    ]);
    expect(await readFile(join(output, "report.md"), "utf8")).toContain("partially_deterministic");
    expect(log.mock.calls.flat().join("\n")).toContain("model calls: 0");
  } finally {
    log.mockRestore();
  }
});

test("post-run selection chooses the highest scored iteration with deterministic tie-breaking", async () => {
  const root = await tempProject("det-selection-");
  await writeFixture(root, syntheticConfig, syntheticEvals);
  await mkdir(join(root, "seed-skill"));
  await writeFile(join(root, "seed-skill", "SKILL.md"), "# Seed\n");
  for (const [iteration, score] of [
    [1, 0.9],
    [2, 0.9]
  ] as const) {
    const skill = join(root, "workspace", "iterations", String(iteration), "skill");
    await mkdir(skill, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), `# Iteration ${iteration}\n`);
    await writeFile(
      join(root, "workspace", "iterations", String(iteration), "summary.json"),
      JSON.stringify({ overall: { normalizedScore: score } })
    );
  }
  const output = await tempProject("det-selection-output-");
  const result = await runDeterminizationReport({
    projectRoot: root,
    catalogRoot,
    outputRoot: output,
    transport: new StaticDeterminizationTransport({ schema_version: "1.0.0", opportunities: [] })
  });
  expect(result.selectedSkillSource).toBe("best_iteration");
  expect(result.selectedSkillDir).toBe(join(root, "workspace", "iterations", "1", "skill"));
});

test("direct-model and Flue transports preserve their role boundary", async () => {
  const model = { provider: "anthropic" as const, name: "claude-sonnet-4-6" };
  const request = { system: "system", prompt: "prompt", model };
  const client: ModelClient = {
    async complete() {
      return { text: '{"schema_version":"1.0.0","opportunities":[]}', usage: { inputTokens: 10 } };
    }
  };
  const direct = await new DirectModelDeterminizationTransport(client).analyze(request);
  expect(direct.response).toEqual({ schema_version: "1.0.0", opportunities: [] });
  expect(direct.usage).toEqual({ inputTokens: 10 });

  const tasks: unknown[] = [];
  const session = {
    async task(text: string, options: unknown) {
      tasks.push({ text, options });
      return {
        data: { schema_version: "1.0.0", opportunities: [] },
        usage: {
          input: 10,
          output: 5,
          cacheRead: 3,
          cacheWrite: 2,
          totalTokens: 20,
          cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 }
        },
        model: { provider: "anthropic", id: "claude-sonnet-4-6" }
      };
    }
  } as unknown as FlueSession;
  const flue = await new FlueDeterminizationTransport(session).analyze(request);
  expect(tasks).toEqual([
    expect.objectContaining({
      text: "prompt",
      options: expect.objectContaining({ agent: "determinizer", model: "anthropic/claude-sonnet-4-6" })
    })
  ]);
  expect(flue).toMatchObject({
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 3
    },
    costUsd: 0.0033
  });
});
