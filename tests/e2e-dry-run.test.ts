import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ModelClient,
  ModelCompletion,
  ModelEvalAgent,
  ModelRequest,
  ModelSkillResearcher
} from "../src/model-agent.js";
import { orchestrateBaseline } from "../src/orchestrator.js";
import { score, syntheticConfig, syntheticEvals, tempProject, writeFixture } from "./helpers.js";

class QueueModelClient implements ModelClient {
  requests: ModelRequest[] = [];

  constructor(private readonly responses: ModelCompletion[]) {}

  async complete(request: ModelRequest): Promise<ModelCompletion> {
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
      resource_decisions: [
        { path: "SKILL.md", placement: "skill", reason: "Keep the core procedure always available." },
        {
          path: "references/risk-guidance.md",
          placement: "reference",
          reason: "Load detailed risk guidance only when a changelog needs it."
        }
      ],
      changes: [
        {
          path: "SKILL.md",
          contents:
            "# Release Summary\n\nSummarise changes with concrete user-facing impact. Read references/risk-guidance.md when risk or migration impact is present.\n"
        },
        {
          path: "references/risk-guidance.md",
          contents: "Describe compatibility impact, migration steps, and verification guidance.\n"
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
  expect(client.requests.map((request) => request.system)).toEqual(
    [
      ["baseline producer", "task-producer"],
      ["baseline judge", "eval-judge"],
      ["researcher", "skill-builder"],
      ["candidate producer", "task-producer"],
      ["candidate judge", "eval-judge"]
    ].map(([, system]) => system)
  );

  await expect(readFile(join(root, "workspace", "baseline", evalCase.id, "RESULT.md"), "utf8")).resolves.toBe(
    "Baseline summary was too thin.\n"
  );
  await expect(readFile(join(root, "workspace", "iterations", "1", "skill", "SKILL.md"), "utf8")).resolves.toContain(
    "concrete user-facing impact"
  );
  await expect(
    readFile(join(root, "workspace", "iterations", "1", "skill", "references", "risk-guidance.md"), "utf8")
  ).resolves.toContain("migration steps");
  await expect(readFile(join(root, "workspace", "iterations", "1", "skill", "RESEARCH.md"), "utf8")).resolves.toContain(
    "`references/risk-guidance.md` — reference"
  );
  await expect(
    readFile(join(root, "workspace", "iterations", "1", "outputs", evalCase.id, "RESULT.md"), "utf8")
  ).resolves.toBe("Improved summary with impact and risk notes.\n");
  await expect(
    readFile(join(root, "workspace", "iterations", "1", "skill", ".autoresearch-transcript.json"), "utf8")
  ).resolves.toContain("Add concrete output guidance");
});

test("dry run previews, tracks, persists, and stops after the observed budget is reached", async () => {
  const root = await tempProject();
  const config = {
    ...syntheticConfig,
    target_score: 0.8,
    max_iterations: 2,
    budget_usd: 0.01
  };
  await writeFixture(root, config, syntheticEvals);

  const seedSkillDir = join(root, "seed-skill");
  await mkdir(seedSkillDir, { recursive: true });
  await writeFile(join(seedSkillDir, "SKILL.md"), "# Release Summary\n");

  const evalCase = syntheticEvals.evals[0];
  const client = new QueueModelClient([
    {
      text: JSON.stringify({
        output_files: [{ path: "RESULT.md", contents: "Baseline summary was too thin.\n" }]
      }),
      usage: { inputTokens: 10, outputTokens: 10 }
    },
    {
      text: JSON.stringify(score(evalCase.id, evalCase.eval_type, "summarise", 0.4)),
      usage: { inputTokens: 10, outputTokens: 10 }
    },
    {
      text: JSON.stringify({
        summary: "Add concrete output guidance.",
        resource_decisions: [{ path: "SKILL.md", placement: "skill", reason: "Improve the core instructions." }],
        changes: [
          {
            path: "SKILL.md",
            contents: "# Release Summary\n\nSummarise changes with concrete user-facing impact and risk notes.\n"
          }
        ]
      }),
      usage: { inputTokens: 2_000, outputTokens: 1_000 }
    }
  ]);

  const result = await orchestrateBaseline({
    projectRoot: root,
    agent: new ModelEvalAgent(client),
    researcher: new ModelSkillResearcher(client),
    runResearch: true,
    seedSkillDir
  });

  expect(result.completedIterations).toBe(0);
  expect(result.events[1]).toMatchObject({
    type: "cost-preview",
    summary: {
      budgetUsd: 0.01,
      planned: {
        totalCalls: 8,
        calls: {
          baseline_producer: 1,
          baseline_judge: 1,
          researcher: 2,
          iteration_producer: 2,
          iteration_judge: 2
        }
      }
    }
  });
  expect(result.events).toContainEqual({
    type: "budget-reached",
    budgetUsd: 0.01,
    actualCostUsd: result.cost.actual.costUsd,
    completedIterations: 0
  });
  expect(result.cost.actual.calls).toMatchObject({
    baseline_producer: 1,
    baseline_judge: 1,
    researcher: 1,
    iteration_producer: 0,
    iteration_judge: 0
  });
  expect(result.cost.actual.costUsd).toBeGreaterThan(0.01);
  await expect(readFile(join(root, "workspace", "cost-summary.json"), "utf8")).resolves.toContain("baseline_producer");
});
