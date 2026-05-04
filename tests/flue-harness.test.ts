import type { FlueSession } from "@flue/sdk/client";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FlueEvalAgent, runFlueAutoresearch } from "../src/flue-harness.js";
import { createEvalSandbox } from "../src/sandbox.js";
import { trackForEval } from "../src/project.js";
import { score, syntheticConfig, syntheticEvals, tempProject, writeFixture } from "./helpers.js";

class MockFlueSession {
  readonly id = "mock";
  prompts: Array<{ text: string; result: unknown; model?: string; role?: string }> = [];

  constructor(private readonly responses: unknown[]) {}

  async prompt(text: string, options?: { result?: unknown; model?: string; role?: string }) {
    this.prompts.push({ text, result: options?.result, model: options?.model, role: options?.role });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No queued Flue response");
    }
    return response;
  }
}

test("FlueEvalAgent uses session structured output and writes eval artifacts", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const evalCase = syntheticEvals.evals[0];
  const session = new MockFlueSession([
    {
      output_files: [{ path: "RESULT.md", contents: "Flue output\n" }]
    },
    score(evalCase.id, evalCase.eval_type, "summarise", 1)
  ]) as unknown as FlueSession;
  const sandbox = createEvalSandbox({
    evalId: evalCase.id,
    inputDir: join(root, "input"),
    referenceDir: join(root, "reference"),
    evalsDir: join(root, "evals"),
    outputDir: join(root, "out")
  });

  const result = await new FlueEvalAgent(session).run({
    evalCase,
    track: trackForEval(syntheticConfig, evalCase.eval_type),
    role: "release-editor",
    modelRoles: { judge: "release-notes-judge" },
    model: { provider: "anthropic", name: "claude-sonnet-4-6" },
    models: {
      producer: { provider: "anthropic", name: "claude-haiku-4-5" },
      judge: { provider: "anthropic", name: "claude-sonnet-4-6" }
    },
    sandbox
  });

  expect(result.total_score).toBe(1);
  expect((session as any).prompts.map((prompt: any) => prompt.model)).toEqual([
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-sonnet-4-6"
  ]);
  expect((session as any).prompts[1].role).toBe("release-notes-judge");
  await expect(readFile(join(sandbox.outputDir, "RESULT.md"), "utf8")).resolves.toBe("Flue output\n");
});

test("runFlueAutoresearch executes the dry run through Flue session prompts", async () => {
  const root = await tempProject();
  const config = { ...syntheticConfig, target_score: 0.8, max_iterations: 1 };
  await writeFixture(root, config, syntheticEvals);
  const seedSkillDir = join(root, "seed-skill");
  await mkdir(seedSkillDir, { recursive: true });
  await writeFile(join(seedSkillDir, "SKILL.md"), "# Seed\n");
  const evalCase = syntheticEvals.evals[0];
  const session = new MockFlueSession([
    {
      output_files: [{ path: "RESULT.md", contents: "Baseline\n" }]
    },
    score(evalCase.id, evalCase.eval_type, "summarise", 0.4),
    {
      summary: "Improve skill",
      changes: [{ path: "SKILL.md", contents: "# Improved\n" }]
    },
    {
      output_files: [{ path: "RESULT.md", contents: "Iteration\n" }]
    },
    score(evalCase.id, evalCase.eval_type, "summarise", 0.9)
  ]) as unknown as MockFlueSession;

  const result = await runFlueAutoresearch({
    session: session as unknown as FlueSession,
    projectRoot: root,
    runResearch: true,
    seedSkillDir
  });

  expect(result.aggregate.overall.normalizedScore).toBe(0.9);
  expect(session.prompts).toHaveLength(5);
  expect(session.prompts.every((prompt) => prompt.result)).toBe(true);
  await expect(readFile(join(root, "workspace", "iterations", "1", "skill", "SKILL.md"), "utf8")).resolves.toBe(
    "# Improved\n"
  );
});
