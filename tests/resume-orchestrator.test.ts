import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelClient, ModelCompletion, ModelEvalAgent, ModelRequest } from "../src/model-agent.js";
import { copySkillSnapshot, orchestrateBaseline, SkillResearcher } from "../src/orchestrator.js";
import { createResearchSnapshotManifest } from "../src/resume.js";
import { EvalAgent } from "../src/runner.js";
import { score, syntheticConfig, syntheticEvals, tempProject, writeFixture } from "./helpers.js";

class QueueModelClient implements ModelClient {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly responses: Array<ModelCompletion | Error>) {}

  async complete(request: ModelRequest): Promise<ModelCompletion> {
    this.requests.push(request);
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No queued model response");
    }
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

async function writeScore(root: string, directory: string, index: number, value: ReturnType<typeof score>) {
  await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, directory, `scores-${index}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeSeed(root: string): Promise<string> {
  const seedSkillDir = join(root, "seed-skill");
  await mkdir(seedSkillDir, { recursive: true });
  await writeFile(join(seedSkillDir, "SKILL.md"), "# Seed\n");
  return seedSkillDir;
}

async function writeCompletedResearch(root: string, iteration = 1): Promise<string> {
  const candidateSkillDir = join(root, "workspace", "iterations", String(iteration), "skill");
  await mkdir(candidateSkillDir, { recursive: true });
  await writeFile(join(candidateSkillDir, "SKILL.md"), `# Candidate ${iteration}\n`);
  await writeFile(
    join(candidateSkillDir, ".autoresearch-transcript.json"),
    JSON.stringify({
      request: { phase: `research iteration ${iteration}` },
      response: JSON.stringify({
        summary: "complete",
        changes: [{ path: "SKILL.md", contents: `# Candidate ${iteration}\n` }]
      })
    })
  );
  return candidateSkillDir;
}

const shouldNotResearch: SkillResearcher = {
  async improve() {
    throw new Error("completed research must not be rerun");
  }
};

test("resume reuses existing baseline scores and generates only missing eval scores", async () => {
  const root = await tempProject();
  const evals = {
    evals: [syntheticEvals.evals[0], { ...syntheticEvals.evals[0], id: "notes-002", title: "Summarise another change" }]
  };
  await writeFixture(root, syntheticConfig, evals);
  const first = score("notes-001", "summarise-changelog", "summarise", 0.4);
  await writeScore(root, join("workspace", "baseline"), 0, first);

  const calls: string[] = [];
  const agent: EvalAgent = {
    async run(request) {
      calls.push(request.evalCase.id);
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.7);
    }
  };

  const result = await orchestrateBaseline({ projectRoot: root, resume: true, agent });

  expect(calls).toEqual(["notes-002"]);
  expect(result.baselineScores.map((item) => item.eval_id)).toEqual(["notes-001", "notes-002"]);
  expect(result.events).toContainEqual({ type: "baseline-resumed", scores: 1, remaining: 1 });
  await expect(readFile(join(root, "workspace", "baseline", "scores-0.json"), "utf8")).resolves.toContain(
    '"total_score": 0.4'
  );
  await expect(readFile(join(root, "workspace", "baseline", "scores-1.json"), "utf8")).resolves.toContain(
    '"eval_id": "notes-002"'
  );
});

test("baseline scores survive another concurrent eval failure and are reused on resume", async () => {
  const root = await tempProject();
  const evals = {
    evals: [syntheticEvals.evals[0], { ...syntheticEvals.evals[0], id: "notes-002", title: "Summarise another change" }]
  };
  await writeFixture(root, { ...syntheticConfig, max_concurrency: 2 }, evals);

  const firstAgent: EvalAgent = {
    async run(request) {
      if (request.evalCase.id === "notes-002") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("second eval interrupted");
      }
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.6);
    }
  };

  await expect(orchestrateBaseline({ projectRoot: root, agent: firstAgent })).rejects.toThrow(
    "second eval interrupted"
  );
  await expect(readFile(join(root, "workspace", "baseline", "scores-0.json"), "utf8")).resolves.toContain(
    '"eval_id": "notes-001"'
  );

  const resumedCalls: string[] = [];
  const resumedAgent: EvalAgent = {
    async run(request) {
      resumedCalls.push(request.evalCase.id);
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.7);
    }
  };
  const result = await orchestrateBaseline({ projectRoot: root, resume: true, agent: resumedAgent });

  expect(resumedCalls).toEqual(["notes-002"]);
  expect(result.baselineScores.map((item) => item.total_score)).toEqual([0.6, 0.7]);
});

test("a failed concurrent run drains a slow success before resume begins", async () => {
  const root = await tempProject();
  const evals = {
    evals: [syntheticEvals.evals[0], { ...syntheticEvals.evals[0], id: "notes-002", title: "Summarise another change" }]
  };
  await writeFixture(root, { ...syntheticConfig, max_concurrency: 2 }, evals);
  const order: string[] = [];
  const firstAgent: EvalAgent = {
    async run(request) {
      if (request.evalCase.id === "notes-001") {
        order.push("fast-failure");
        throw new Error("first eval interrupted");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      order.push("slow-success");
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.6);
    }
  };

  await expect(orchestrateBaseline({ projectRoot: root, agent: firstAgent })).rejects.toThrow("first eval interrupted");
  expect(order).toEqual(["fast-failure", "slow-success"]);
  await expect(readFile(join(root, "workspace", "baseline", "scores-1.json"), "utf8")).resolves.toContain(
    '"eval_id": "notes-002"'
  );

  const resumedCalls: string[] = [];
  await orchestrateBaseline({
    projectRoot: root,
    resume: true,
    agent: {
      async run(request) {
        resumedCalls.push(request.evalCase.id);
        return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.7);
      }
    }
  });
  expect(resumedCalls).toEqual(["notes-001"]);
});

test("a failed concurrent iteration drains a slow success before resume begins", async () => {
  const root = await tempProject();
  const evals = {
    evals: [syntheticEvals.evals[0], { ...syntheticEvals.evals[0], id: "notes-002", title: "Summarise another change" }]
  };
  await writeFixture(root, { ...syntheticConfig, max_iterations: 1, max_concurrency: 2 }, evals);
  const seedSkillDir = await writeSeed(root);
  await writeScore(root, join("workspace", "baseline"), 0, score("notes-001", "summarise-changelog", "summarise", 0.2));
  await writeScore(root, join("workspace", "baseline"), 1, score("notes-002", "summarise-changelog", "summarise", 0.2));
  await writeCompletedResearch(root);

  const order: string[] = [];
  await expect(
    orchestrateBaseline({
      projectRoot: root,
      resume: true,
      runResearch: true,
      seedSkillDir,
      researcher: shouldNotResearch,
      agent: {
        async run(request) {
          if (request.evalCase.id === "notes-001") {
            order.push("fast-failure");
            throw new Error("first iteration eval interrupted");
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          order.push("slow-success");
          return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.6);
        }
      }
    })
  ).rejects.toThrow("first iteration eval interrupted");
  expect(order).toEqual(["fast-failure", "slow-success"]);
  await expect(readFile(join(root, "workspace", "iterations", "1", "scores-1.json"), "utf8")).resolves.toContain(
    '"eval_id": "notes-002"'
  );

  const resumedCalls: string[] = [];
  await orchestrateBaseline({
    projectRoot: root,
    resume: true,
    runResearch: true,
    seedSkillDir,
    researcher: shouldNotResearch,
    agent: {
      async run(request) {
        resumedCalls.push(request.evalCase.id);
        return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.9);
      }
    }
  });
  expect(resumedCalls).toEqual(["notes-001"]);
});

test("resume reuses a complete generated baseline without an eval adapter", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  await writeScore(root, join("workspace", "baseline"), 0, score("notes-001", "summarise-changelog", "summarise", 0.6));

  const result = await orchestrateBaseline({ projectRoot: root, resume: true });

  expect(result.baselineScores[0].total_score).toBe(0.6);
  expect(result.events).toContainEqual({ type: "baseline-resumed", scores: 1, remaining: 0 });
});

test("resume still requires an eval adapter when recovery cannot supply a baseline score", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);

  await expect(orchestrateBaseline({ projectRoot: root, resume: true })).rejects.toThrow(
    "No eval agent was provided to resume the incomplete baseline run"
  );
});

test("resume reuses completed research and scores, then rebuilds a missing iteration summary", async () => {
  const root = await tempProject();
  await writeFixture(root, { ...syntheticConfig, max_iterations: 1 }, syntheticEvals);
  const seedSkillDir = await writeSeed(root);
  await writeScore(root, join("workspace", "baseline"), 0, score("notes-001", "summarise-changelog", "summarise", 0.2));
  const candidateSkillDir = await writeCompletedResearch(root);
  await writeScore(
    root,
    join("workspace", "iterations", "1"),
    0,
    score("notes-001", "summarise-changelog", "summarise", 0.9)
  );

  const agent: EvalAgent = {
    async run() {
      throw new Error("completed score must not be rerun");
    }
  };

  const result = await orchestrateBaseline({
    projectRoot: root,
    resume: true,
    runResearch: true,
    seedSkillDir,
    researcher: shouldNotResearch,
    agent
  });

  expect(result.completedIterations).toBe(1);
  expect(result.bestIteration?.skillDir).toBe(candidateSkillDir);
  expect(result.aggregate.overall.normalizedScore).toBe(0.9);
  expect(result.events).toContainEqual({
    type: "iteration-research-resumed",
    iteration: 1,
    candidateSkillDir
  });
  expect(result.events).toContainEqual({ type: "eval-score-resumed", iteration: 1, evalId: "notes-001" });
  expect(result.events).toContainEqual({ type: "iteration-summary-rebuilt", iteration: 1 });
  await expect(readFile(join(root, "workspace", "iterations", "1", "summary.json"), "utf8")).resolves.toContain(
    '"normalizedScore": 0.9'
  );
});

test("resume runs only a missing judge from validated producer output", async () => {
  const root = await tempProject();
  await writeFixture(root, { ...syntheticConfig, max_iterations: 1 }, syntheticEvals);
  const seedSkillDir = await writeSeed(root);
  await writeScore(root, join("workspace", "baseline"), 0, score("notes-001", "summarise-changelog", "summarise", 0.2));
  await writeCompletedResearch(root);
  const outputDir = join(root, "workspace", "iterations", "1", "outputs", "notes-001");
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "RESULT.md"), "Already produced\n");
  await writeFile(
    join(outputDir, "producer-flue-transcript.json"),
    JSON.stringify({
      request: { phase: "producer eval notes-001" },
      response: { output_files: [{ path: "RESULT.md", contents: "Already produced\n" }] }
    })
  );

  let runCalls = 0;
  let judgeCalls = 0;
  const agent: EvalAgent = {
    async run() {
      runCalls++;
      throw new Error("producer must not be rerun");
    },
    async judge(request, outputFiles) {
      judgeCalls++;
      expect(outputFiles).toEqual([{ path: "RESULT.md", contents: "Already produced\n" }]);
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.9);
    }
  };

  const result = await orchestrateBaseline({
    projectRoot: root,
    resume: true,
    runResearch: true,
    seedSkillDir,
    researcher: shouldNotResearch,
    agent
  });

  expect(runCalls).toBe(0);
  expect(judgeCalls).toBe(1);
  expect(result.events).toContainEqual({ type: "eval-producer-resumed", iteration: 1, evalId: "notes-001" });
  await expect(readFile(join(outputDir, "RESULT.md"), "utf8")).resolves.toBe("Already produced\n");
  await expect(readFile(join(root, "workspace", "iterations", "1", "scores-0.json"), "utf8")).resolves.toContain(
    '"total_score": 0.9'
  );
});

test("resume rebuilds a missing score from a completed judge transcript without adapters", async () => {
  const root = await tempProject();
  await writeFixture(root, { ...syntheticConfig, max_iterations: 1 }, syntheticEvals);
  const seedSkillDir = await writeSeed(root);
  await writeScore(root, join("workspace", "baseline"), 0, score("notes-001", "summarise-changelog", "summarise", 0.2));
  await writeCompletedResearch(root);
  const outputDir = join(root, "workspace", "iterations", "1", "outputs", "notes-001");
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, "judge-flue-transcript.json"),
    JSON.stringify({
      request: { phase: "judge eval notes-001" },
      response: score("notes-001", "summarise-changelog", "summarise", 0.9)
    })
  );

  const result = await orchestrateBaseline({
    projectRoot: root,
    resume: true,
    runResearch: true,
    seedSkillDir
  });

  expect(result.events).toContainEqual({ type: "eval-judge-resumed", iteration: 1, evalId: "notes-001" });
  await expect(readFile(join(root, "workspace", "iterations", "1", "scores-0.json"), "utf8")).resolves.toContain(
    '"total_score": 0.9'
  );
});

test.each([
  { label: "baseline", scoreDir: join("workspace", "baseline"), outputDir: join("workspace", "baseline") },
  {
    label: "iteration",
    scoreDir: join("workspace", "iterations", "1"),
    outputDir: join("workspace", "iterations", "1", "outputs")
  }
])("resume rejects a $label score that conflicts with its judge transcript", async ({ label, scoreDir, outputDir }) => {
  const root = await tempProject();
  await writeFixture(root, { ...syntheticConfig, max_iterations: 1 }, syntheticEvals);
  const seedSkillDir = await writeSeed(root);
  await writeScore(root, join("workspace", "baseline"), 0, score("notes-001", "summarise-changelog", "summarise", 0.2));
  if (label === "iteration") {
    await writeCompletedResearch(root);
    await writeScore(root, scoreDir, 0, score("notes-001", "summarise-changelog", "summarise", 0.8));
  }
  const evalOutputDir = join(root, outputDir, "notes-001");
  await mkdir(evalOutputDir, { recursive: true });
  await writeFile(
    join(evalOutputDir, "judge-flue-transcript.json"),
    JSON.stringify({
      request: { phase: "judge eval notes-001" },
      response: score("notes-001", "summarise-changelog", "summarise", 0.9)
    })
  );

  await expect(
    orchestrateBaseline({
      projectRoot: root,
      resume: true,
      runResearch: label === "iteration",
      seedSkillDir
    })
  ).rejects.toThrow("persisted score does not match judge transcript");
});

test("resume archives incomplete research before rerunning the researcher", async () => {
  const root = await tempProject();
  await writeFixture(root, { ...syntheticConfig, max_iterations: 1 }, syntheticEvals);
  const seedSkillDir = await writeSeed(root);
  await writeScore(root, join("workspace", "baseline"), 0, score("notes-001", "summarise-changelog", "summarise", 0.2));
  const partialSkillDir = join(root, "workspace", "iterations", "1", "skill");
  await mkdir(partialSkillDir, { recursive: true });
  await writeFile(join(partialSkillDir, "PARTIAL.md"), "interrupted\n");

  let researchCalls = 0;
  const researcher: SkillResearcher = {
    async improve(request) {
      researchCalls++;
      await copySkillSnapshot(request.previousSkillDir, request.candidateSkillDir);
      await writeFile(
        join(request.candidateSkillDir, ".autoresearch-iteration.json"),
        JSON.stringify({
          iteration: 1,
          manifest: await createResearchSnapshotManifest(request.candidateSkillDir)
        })
      );
    }
  };
  const agent: EvalAgent = {
    async run(request) {
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.9);
    }
  };

  await orchestrateBaseline({ projectRoot: root, resume: true, runResearch: true, seedSkillDir, researcher, agent });

  expect(researchCalls).toBe(1);
  await expect(
    readFile(join(root, "workspace", "resume-backups", "iteration-1-research", "PARTIAL.md"), "utf8")
  ).resolves.toBe("interrupted\n");
  await expect(readFile(join(partialSkillDir, "SKILL.md"), "utf8")).resolves.toBe("# Seed\n");
});

test("resume archives incomplete producer output before rerunning producer and judge", async () => {
  const root = await tempProject();
  await writeFixture(root, { ...syntheticConfig, max_iterations: 1 }, syntheticEvals);
  const seedSkillDir = await writeSeed(root);
  await writeScore(root, join("workspace", "baseline"), 0, score("notes-001", "summarise-changelog", "summarise", 0.2));
  await writeCompletedResearch(root);
  const outputDir = join(root, "workspace", "iterations", "1", "outputs", "notes-001");
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, "producer-flue-transcript.json"),
    JSON.stringify({
      request: { phase: "producer eval notes-001" },
      response: { output_files: [{ path: "RESULT.md", contents: "missing\n" }] }
    })
  );

  let runCalls = 0;
  const agent: EvalAgent = {
    async run(request) {
      runCalls++;
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.9);
    }
  };
  await orchestrateBaseline({
    projectRoot: root,
    resume: true,
    runResearch: true,
    seedSkillDir,
    researcher: shouldNotResearch,
    agent
  });

  expect(runCalls).toBe(1);
  await expect(
    stat(join(root, "workspace", "resume-backups", "iteration-1-notes-001-producer", "producer-flue-transcript.json"))
  ).resolves.toBeTruthy();
});

test("resume rejects evaluation artifacts that have no completed candidate research", async () => {
  const root = await tempProject();
  await writeFixture(root, { ...syntheticConfig, max_iterations: 1 }, syntheticEvals);
  const seedSkillDir = await writeSeed(root);
  await writeScore(root, join("workspace", "baseline"), 0, score("notes-001", "summarise-changelog", "summarise", 0.2));
  await writeScore(
    root,
    join("workspace", "iterations", "1"),
    0,
    score("notes-001", "summarise-changelog", "summarise", 0.9)
  );

  await expect(
    orchestrateBaseline({
      projectRoot: root,
      resume: true,
      runResearch: true,
      seedSkillDir,
      researcher: shouldNotResearch,
      agent: {
        async run() {
          throw new Error("must not run");
        }
      }
    })
  ).rejects.toThrow("evaluation artifacts exist without completed research: scores-0.json");
});

test("a second invocation resumes at judge after the first invocation fails there", async () => {
  const root = await tempProject();
  await writeFixture(root, { ...syntheticConfig, max_iterations: 1 }, syntheticEvals);
  const seedSkillDir = await writeSeed(root);
  await writeScore(root, join("workspace", "baseline"), 0, score("notes-001", "summarise-changelog", "summarise", 0.2));
  await writeCompletedResearch(root);

  const firstClient = new QueueModelClient([
    JSON.stringify({ output_files: [{ path: "RESULT.md", contents: "Expensive producer result\n" }] }),
    new Error("provider quota exhausted")
  ]);

  await expect(
    orchestrateBaseline({
      projectRoot: root,
      resume: true,
      runResearch: true,
      seedSkillDir,
      researcher: shouldNotResearch,
      agent: new ModelEvalAgent(firstClient)
    })
  ).rejects.toThrow("provider quota exhausted");

  const outputDir = join(root, "workspace", "iterations", "1", "outputs", "notes-001");
  await expect(readFile(join(outputDir, "RESULT.md"), "utf8")).resolves.toBe("Expensive producer result\n");
  await expect(stat(join(outputDir, "producer-transcript.json"))).resolves.toBeTruthy();
  await expect(stat(join(root, "workspace", "iterations", "1", "scores-0.json"))).rejects.toMatchObject({
    code: "ENOENT"
  });

  const secondClient = new QueueModelClient([
    JSON.stringify(score("notes-001", "summarise-changelog", "summarise", 0.9))
  ]);
  const result = await orchestrateBaseline({
    projectRoot: root,
    resume: true,
    runResearch: true,
    seedSkillDir,
    researcher: shouldNotResearch,
    agent: new ModelEvalAgent(secondClient)
  });

  expect(secondClient.requests.map((request) => request.system)).toEqual(["eval-judge"]);
  expect(result.completedIterations).toBe(1);
  expect(result.aggregate.overall.normalizedScore).toBe(0.9);
  expect(result.events).toContainEqual({ type: "eval-producer-resumed", iteration: 1, evalId: "notes-001" });
  await expect(readFile(join(outputDir, "RESULT.md"), "utf8")).resolves.toBe("Expensive producer result\n");
  await expect(readFile(join(root, "workspace", "iterations", "1", "summary.json"), "utf8")).resolves.toContain(
    '"normalizedScore": 0.9'
  );
});

test("resume completes the current partial iteration before researching a later iteration", async () => {
  const root = await tempProject();
  await writeFixture(root, { ...syntheticConfig, max_iterations: 2 }, syntheticEvals);
  const seedSkillDir = await writeSeed(root);
  await writeScore(root, join("workspace", "baseline"), 0, score("notes-001", "summarise-changelog", "summarise", 0.2));
  const firstCandidate = await writeCompletedResearch(root, 1);

  const order: string[] = [];
  const agent: EvalAgent = {
    async run(request) {
      order.push(`eval-${request.sandbox.outputDir.includes(join("iterations", "1")) ? 1 : 2}`);
      return score(
        request.evalCase.id,
        request.evalCase.eval_type,
        request.track.id,
        request.sandbox.outputDir.includes(join("iterations", "1")) ? 0.5 : 0.9
      );
    }
  };
  const researcher: SkillResearcher = {
    async improve(request) {
      order.push(`research-${request.iteration}`);
      expect(request.iteration).toBe(2);
      expect(request.previousSkillDir).toBe(firstCandidate);
      expect(request.previousScores[0].total_score).toBe(0.5);
      await copySkillSnapshot(request.previousSkillDir, request.candidateSkillDir);
      await writeFile(
        join(request.candidateSkillDir, ".autoresearch-iteration.json"),
        JSON.stringify({
          iteration: request.iteration,
          manifest: await createResearchSnapshotManifest(request.candidateSkillDir)
        })
      );
    }
  };

  const result = await orchestrateBaseline({
    projectRoot: root,
    resume: true,
    runResearch: true,
    seedSkillDir,
    researcher,
    agent
  });

  expect(order).toEqual(["eval-1", "research-2", "eval-2"]);
  expect(result.completedIterations).toBe(2);
  expect(result.events.at(-1)).toMatchObject({ type: "target-score-reached", iteration: 2 });
});
