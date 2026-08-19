import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ModelRunCostTracker,
  type ModelCallPreview,
  type ModelUsage
} from "../packages/skills-autoresearch/src/cost.js";
import {
  FlueEvalAgent,
  FlueSkillResearcher,
  runFlueAutoresearch
} from "../packages/skills-autoresearch/src/flue-harness.js";
import type { RawDeterminizationAnalysis } from "../packages/skills-autoresearch/src/flue-agents.js";
import type {
  FlueRoleDispatcher,
  FlueRoleRequest,
  FlueRoleResult
} from "../packages/skills-autoresearch/src/flue-runtime.js";
import {
  buildJudgeModelRequest,
  buildProduceModelRequest,
  buildResearchModelRequest
} from "../packages/skills-autoresearch/src/model-agent.js";
import { loadProject, trackForEval } from "../packages/skills-autoresearch/src/project.js";
import type { EvalAgentRequest } from "../packages/skills-autoresearch/src/runner.js";
import { createEvalSandbox } from "../packages/skills-autoresearch/src/sandbox.js";
import type {
  EvalScore,
  ModelProduceResponse,
  SkillResearchPatch
} from "../packages/skills-autoresearch/src/schemas.js";
import { score, syntheticConfig, syntheticEvals, tempProject, writeFixture } from "./helpers.js";

type MockRole = "producer" | "judge" | "researcher" | "determinizer";

interface QueuedRoleResponse {
  role: MockRole;
  data: unknown;
  usage?: ModelUsage;
  costUsd?: number;
}

class MockFlueRoleDispatcher implements FlueRoleDispatcher {
  readonly calls: Array<{ role: MockRole; request: FlueRoleRequest }> = [];
  readonly #responses: QueuedRoleResponse[];

  constructor(responses: QueuedRoleResponse[]) {
    this.#responses = responses;
  }

  produce(request: FlueRoleRequest): Promise<FlueRoleResult<ModelProduceResponse>> {
    return this.#next("producer", request);
  }

  judge(request: FlueRoleRequest): Promise<FlueRoleResult<EvalScore>> {
    return this.#next("judge", request);
  }

  research(request: FlueRoleRequest): Promise<FlueRoleResult<SkillResearchPatch>> {
    return this.#next("researcher", request);
  }

  determinize(request: FlueRoleRequest): Promise<FlueRoleResult<RawDeterminizationAnalysis>> {
    return this.#next("determinizer", request);
  }

  async #next<T>(role: MockRole, request: FlueRoleRequest): Promise<FlueRoleResult<T>> {
    this.calls.push({ role, request });
    const response = this.#responses.shift();
    if (!response) {
      throw new Error("No queued Flue role response");
    }
    if (response.role !== role) {
      throw new Error(`Expected ${response.role} role call, received ${role}`);
    }
    return {
      data: response.data as T,
      text: `${role} response`,
      usage: response.usage ?? {},
      costUsd: response.costUsd ?? 0,
      instanceId: `mock-${role}-${this.calls.length}`,
      submissionId: `submission-${this.calls.length}`
    };
  }
}

const emptyPreview: ModelCallPreview = {
  evalCount: 1,
  maxIterations: 1,
  maxConcurrency: 1,
  withBaseline: false,
  runResearch: true,
  modelBacked: true,
  calls: {
    baseline_producer: 1,
    baseline_judge: 1,
    researcher: 1,
    iteration_producer: 1,
    iteration_judge: 1
  },
  totalCalls: 5
};

test("FlueEvalAgent dispatches producer then judge and preserves artifacts and cost accounting", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const evalCase = syntheticEvals.evals[0];
  const produced = {
    output_files: [{ path: "RESULT.md", contents: "Flue output\n" }]
  };
  const judged = score(evalCase.id, evalCase.eval_type, "summarise", 1);
  const dispatcher = new MockFlueRoleDispatcher([
    {
      role: "producer",
      data: produced,
      usage: { inputTokens: 10, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 },
      costUsd: 0.012
    },
    {
      role: "judge",
      data: judged,
      usage: { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 6 },
      costUsd: 0.023
    }
  ]);
  const sandbox = createEvalSandbox({
    evalId: evalCase.id,
    inputDir: join(root, "input"),
    referenceDir: join(root, "reference"),
    evalsDir: join(root, "evals"),
    outputDir: join(root, "out")
  });
  const costTracker = new ModelRunCostTracker(emptyPreview);
  const request: EvalAgentRequest = {
    evalCase,
    track: trackForEval(syntheticConfig, evalCase.eval_type),
    role: "task-producer",
    modelRoles: { judge: "eval-judge" },
    model: { provider: "anthropic", name: "claude-sonnet-4-6" },
    models: {
      producer: { provider: "anthropic", name: "claude-haiku-4-5" },
      judge: { provider: "anthropic", name: "claude-sonnet-4-6" }
    },
    costTracker,
    sandbox
  };
  const expectedProduceRequest = await buildProduceModelRequest(request);
  const expectedJudgeRequest = await buildJudgeModelRequest(request, produced.output_files);

  const result = await new FlueEvalAgent(dispatcher).run(request);

  expect(result.total_score).toBe(1);
  expect(dispatcher.calls).toEqual([
    {
      role: "producer",
      request: { prompt: expectedProduceRequest.prompt, model: "anthropic/claude-haiku-4-5" }
    },
    {
      role: "judge",
      request: { prompt: expectedJudgeRequest.prompt, model: "anthropic/claude-sonnet-4-6" }
    }
  ]);
  expect(dispatcher.calls[0].request.prompt).not.toContain("Role instructions:");
  expect(dispatcher.calls[0].request.prompt).toContain("Producer role: task-producer");
  expect(dispatcher.calls[1].request.prompt).not.toContain("Role instructions:");
  expect(dispatcher.calls[1].request.prompt).toContain("Judge role: eval-judge");
  expect(dispatcher.calls[1].request.prompt).toContain("Available paths: ./evals, ./reference, ./output.");
  expect(dispatcher.calls[1].request.prompt).not.toContain("release-notes-alpha");
  expect(costTracker.summary().actual).toMatchObject({
    calls: { iteration_producer: 1, iteration_judge: 1 },
    totalCalls: 2,
    totalUsage: {
      inputTokens: 30,
      outputTokens: 7,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 10
    },
    costUsd: 0.035,
    records: [
      {
        role: "iteration_producer",
        phase: `producer eval ${evalCase.id}`,
        model: { provider: "anthropic", name: "claude-haiku-4-5" },
        usage: { inputTokens: 10, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 },
        costUsd: 0.012
      },
      {
        role: "iteration_judge",
        phase: `judge eval ${evalCase.id}`,
        model: { provider: "anthropic", name: "claude-sonnet-4-6" },
        usage: { inputTokens: 20, outputTokens: 5, cacheReadInputTokens: 6 },
        costUsd: 0.023
      }
    ]
  });
  await expect(readFile(join(sandbox.outputDir, "RESULT.md"), "utf8")).resolves.toBe("Flue output\n");
  await expect(
    readFile(join(sandbox.outputDir, ".phase-workspaces", "judge", "output", "RESULT.md"), "utf8")
  ).resolves.toBe("Flue output\n");
  await expect(stat(join(sandbox.outputDir, ".phase-workspaces", "judge", "skill"))).rejects.toMatchObject({
    code: "ENOENT"
  });
  await expect(readFile(join(sandbox.outputDir, "producer-flue-transcript.json"), "utf8")).resolves.toContain(
    '"Flue output\\n"'
  );
  await expect(readFile(join(sandbox.outputDir, "judge-flue-transcript.json"), "utf8")).resolves.toContain(
    '"total_score": 1'
  );
});

test("FlueEvalAgent supports judge-only resume without dispatching a producer", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const evalCase = syntheticEvals.evals[0];
  const outputFiles = [{ path: "RESULT.md", contents: "Recovered producer output\n" }];
  const dispatcher = new MockFlueRoleDispatcher([
    { role: "judge", data: score(evalCase.id, evalCase.eval_type, "summarise", 0.75) }
  ]);
  const request: EvalAgentRequest = {
    evalCase,
    track: trackForEval(syntheticConfig, evalCase.eval_type),
    role: "task-producer",
    modelRoles: { judge: "eval-judge" },
    model: { provider: "anthropic", name: "claude-sonnet-4-6" },
    models: { judge: { provider: "anthropic", name: "claude-opus-4-1" } },
    sandbox: createEvalSandbox({
      evalId: evalCase.id,
      inputDir: join(root, "input"),
      referenceDir: join(root, "reference"),
      evalsDir: join(root, "evals"),
      outputDir: join(root, "out")
    })
  };
  const expectedRequest = await buildJudgeModelRequest(request, outputFiles);

  const result = await new FlueEvalAgent(dispatcher).judge(request, outputFiles);

  expect(result.total_score).toBe(0.75);
  expect(dispatcher.calls).toEqual([
    {
      role: "judge",
      request: { prompt: expectedRequest.prompt, model: "anthropic/claude-opus-4-1" }
    }
  ]);
  await expect(readFile(join(request.sandbox.outputDir, "RESULT.md"), "utf8")).resolves.toBe(
    "Recovered producer output\n"
  );
  await expect(stat(join(request.sandbox.outputDir, "producer-flue-transcript.json"))).rejects.toMatchObject({
    code: "ENOENT"
  });
  await expect(readFile(join(request.sandbox.outputDir, "judge-flue-transcript.json"), "utf8")).resolves.toContain(
    '"total_score": 0.75'
  );
});

test("FlueEvalAgent checks the budget before dispatching a role", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const evalCase = syntheticEvals.evals[0];
  const costTracker = new ModelRunCostTracker(emptyPreview, 0.01);
  costTracker.recordModelCall({
    role: "baseline_producer",
    model: { provider: "anthropic", name: "claude-haiku-4-5" },
    costUsd: 0.01
  });
  const dispatcher = new MockFlueRoleDispatcher([]);

  await expect(
    new FlueEvalAgent(dispatcher).run({
      evalCase,
      track: trackForEval(syntheticConfig, evalCase.eval_type),
      role: "task-producer",
      model: { provider: "anthropic", name: "claude-sonnet-4-6" },
      costTracker,
      sandbox: createEvalSandbox({
        evalId: evalCase.id,
        inputDir: join(root, "input"),
        referenceDir: join(root, "reference"),
        evalsDir: join(root, "evals"),
        outputDir: join(root, "out")
      })
    })
  ).rejects.toThrow("Model budget reached");
  expect(dispatcher.calls).toEqual([]);
});

test("FlueSkillResearcher dispatches the exact request and preserves research artifacts", async () => {
  const root = await tempProject();
  const config = {
    ...syntheticConfig,
    models: { researcher: { provider: "anthropic", name: "claude-opus-4-1" } }
  };
  await writeFixture(root, config, syntheticEvals);
  const project = await loadProject(root);
  const previousSkillDir = join(root, "previous-skill");
  const candidateSkillDir = join(root, "candidate-skill");
  await mkdir(previousSkillDir, { recursive: true });
  await writeFile(join(previousSkillDir, "SKILL.md"), "# Previous\n");
  const patch = {
    summary: "Improve skill",
    resource_decisions: [
      { path: "SKILL.md", placement: "skill" as const, reason: "Improve the core workflow." },
      {
        path: "scripts/check.js",
        placement: "script" as const,
        reason: "Reuse deterministic checking logic."
      }
    ],
    changes: [
      { path: "SKILL.md", contents: "# Improved\n" },
      { path: "scripts/check.js", contents: "export const check = () => true;\n" }
    ]
  };
  const dispatcher = new MockFlueRoleDispatcher([
    {
      role: "researcher",
      data: patch,
      usage: { inputTokens: 40, outputTokens: 8 },
      costUsd: 0.15
    }
  ]);
  const costTracker = new ModelRunCostTracker(emptyPreview);
  const request = {
    project,
    iteration: 1,
    previousSkillDir,
    candidateSkillDir,
    baselineScores: [],
    previousScores: [],
    previousAggregate: {
      tracks: [],
      overall: { score: 0, maxScore: 1, normalizedScore: 0, evalCount: 0 }
    },
    costTracker
  };
  const expectedRequest = await buildResearchModelRequest(request);

  await new FlueSkillResearcher(dispatcher).improve(request);

  expect(dispatcher.calls).toEqual([
    {
      role: "researcher",
      request: { prompt: expectedRequest.prompt, model: "anthropic/claude-opus-4-1" }
    }
  ]);
  expect(costTracker.summary().actual).toMatchObject({
    calls: { researcher: 1 },
    totalCalls: 1,
    totalUsage: {
      inputTokens: 40,
      outputTokens: 8,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0
    },
    costUsd: 0.15,
    records: [
      {
        role: "researcher",
        phase: "research iteration 1",
        model: { provider: "anthropic", name: "claude-opus-4-1" },
        usage: { inputTokens: 40, outputTokens: 8 },
        costUsd: 0.15
      }
    ]
  });
  await expect(readFile(join(candidateSkillDir, "SKILL.md"), "utf8")).resolves.toBe("# Improved\n");
  await expect(readFile(join(candidateSkillDir, "RESEARCH.md"), "utf8")).resolves.toContain(
    "`scripts/check.js` — passed"
  );
  await expect(readFile(join(candidateSkillDir, ".autoresearch-flue-transcript.json"), "utf8")).resolves.toContain(
    '"summary": "Improve skill"'
  );
});

test("runFlueAutoresearch executes the dry run through the role dispatcher", async () => {
  const root = await tempProject();
  const config = { ...syntheticConfig, target_score: 0.8, max_iterations: 2 };
  await writeFixture(root, config, syntheticEvals);
  const seedSkillDir = join(root, "seed-skill");
  await mkdir(seedSkillDir, { recursive: true });
  await writeFile(join(seedSkillDir, "SKILL.md"), "# Seed\n");
  const evalCase = syntheticEvals.evals[0];
  const dispatcher = new MockFlueRoleDispatcher([
    {
      role: "producer",
      data: { output_files: [{ path: "RESULT.md", contents: "Baseline\n" }] }
    },
    { role: "judge", data: score(evalCase.id, evalCase.eval_type, "summarise", 0.4) },
    {
      role: "researcher",
      data: {
        summary: "Improve skill",
        resource_decisions: [
          { path: "SKILL.md", placement: "skill", reason: "Improve the core workflow." },
          { path: "scripts/check.js", placement: "script", reason: "Reuse deterministic checking logic." }
        ],
        changes: [
          { path: "SKILL.md", contents: "# Improved 1\n" },
          { path: "scripts/check.js", contents: "export const check = () => true;\n" }
        ]
      }
    },
    {
      role: "producer",
      data: { output_files: [{ path: "RESULT.md", contents: "Iteration\n" }] }
    },
    { role: "judge", data: score(evalCase.id, evalCase.eval_type, "summarise", 0.5) },
    {
      role: "researcher",
      data: {
        summary: "Improve skill again",
        resource_decisions: [{ path: "SKILL.md", placement: "skill", reason: "Refine the core workflow." }],
        changes: [{ path: "SKILL.md", contents: "# Improved 2\n" }]
      }
    },
    {
      role: "producer",
      data: { output_files: [{ path: "RESULT.md", contents: "Iteration 2\n" }] }
    },
    { role: "judge", data: score(evalCase.id, evalCase.eval_type, "summarise", 0.9) }
  ]);

  const result = await runFlueAutoresearch({
    dispatcher,
    projectRoot: root,
    runResearch: true,
    seedSkillDir
  });

  expect(result.aggregate.overall.normalizedScore).toBe(0.9);
  expect(dispatcher.calls.map(({ role }) => role)).toEqual([
    "producer",
    "judge",
    "researcher",
    "producer",
    "judge",
    "researcher",
    "producer",
    "judge"
  ]);
  await expect(readFile(join(root, "workspace", "iterations", "2", "skill", "SKILL.md"), "utf8")).resolves.toBe(
    "# Improved 2\n"
  );
  await expect(readFile(join(root, "workspace", "iterations", "1", "skill", "RESEARCH.md"), "utf8")).resolves.toContain(
    "`scripts/check.js` — passed"
  );
});
