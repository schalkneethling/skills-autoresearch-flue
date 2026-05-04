import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelClient, ModelEvalAgent, ModelRequest, ModelSkillResearcher } from "../src/model-agent.js";
import { orchestrateBaseline } from "../src/orchestrator.js";
import { score, syntheticConfig, syntheticEvals, tempProject, writeFixture } from "./helpers.js";

class QueueModelClient implements ModelClient {
  requests: ModelRequest[] = [];

  constructor(private readonly responses: string[]) {}

  async complete(request: ModelRequest): Promise<string> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No queued model response");
    }
    return response;
  }
}

test("dry run executes baseline, applies a candidate skill patch, and scores one iteration", async () => {
  const root = await tempProject();
  const config = {
    ...syntheticConfig,
    target_score: 0.8,
    max_iterations: 1
  };
  await writeFixture(root, config, syntheticEvals);

  const seedSkillDir = join(root, "seed-skill");
  await mkdir(seedSkillDir, { recursive: true });
  await writeFile(join(seedSkillDir, "SKILL.md"), "# Release Summary\n\nSummarise changes briefly.\n");

  const evalCase = syntheticEvals.evals[0];
  const client = new QueueModelClient([
    JSON.stringify({
      output_files: [{ path: "RESULT.md", contents: "Baseline summary was too thin.\n" }]
    }),
    JSON.stringify(score(evalCase.id, evalCase.eval_type, "summarise", 0.4)),
    JSON.stringify({
      summary: "Add concrete output guidance.",
      changes: [
        {
          path: "SKILL.md",
          contents: "# Release Summary\n\nSummarise changes with concrete user-facing impact and risk notes.\n"
        }
      ]
    }),
    JSON.stringify({
      output_files: [{ path: "RESULT.md", contents: "Improved summary with impact and risk notes.\n" }]
    }),
    JSON.stringify(score(evalCase.id, evalCase.eval_type, "summarise", 0.9))
  ]);

  const result = await orchestrateBaseline({
    projectRoot: root,
    agent: new ModelEvalAgent(client),
    researcher: new ModelSkillResearcher(client),
    runResearch: true,
    seedSkillDir
  });

  expect(result.completedIterations).toBe(1);
  expect(result.aggregate.overall.normalizedScore).toBe(0.9);
  expect(result.events.at(-1)).toMatchObject({ type: "target-score-reached", iteration: 1 });
  expect(client.requests.map((request) => request.system)).toEqual([
    "release-editor",
    "judge",
    "skill-builder",
    "release-editor",
    "judge"
  ]);

  await expect(readFile(join(root, "workspace", "baseline", evalCase.id, "RESULT.md"), "utf8")).resolves.toBe(
    "Baseline summary was too thin.\n"
  );
  await expect(readFile(join(root, "workspace", "iterations", "1", "skill", "SKILL.md"), "utf8")).resolves.toContain(
    "concrete user-facing impact"
  );
  await expect(
    readFile(join(root, "workspace", "iterations", "1", "outputs", evalCase.id, "RESULT.md"), "utf8")
  ).resolves.toBe("Improved summary with impact and risk notes.\n");
  await expect(
    readFile(join(root, "workspace", "iterations", "1", "skill", ".autoresearch-transcript.json"), "utf8")
  ).resolves.toContain("Add concrete output guidance");
});
