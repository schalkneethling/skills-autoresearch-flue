import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createEvalSandbox } from "../src/sandbox.js";
import { runEval, runWithConcurrency, EvalAgent } from "../src/runner.js";
import { copySkillSnapshot, orchestrateBaseline, SkillResearcher } from "../src/orchestrator.js";
import {
  score,
  securityConfig,
  securityEvals,
  syntheticConfig,
  syntheticEvals,
  tempProject,
  writeFixture
} from "./helpers.js";

test("sandbox rejects mutations in read-only mounts with EROFS", async () => {
  const root = await tempProject();
  for (const dir of ["input", "reference", "evals", "skill", "out"]) {
    await mkdir(join(root, dir), { recursive: true });
  }
  await writeFile(join(root, "input", "case.txt"), "input");
  await writeFile(join(root, "reference", "ref.txt"), "ref");

  const sandbox = createEvalSandbox({
    evalId: "case-1",
    inputDir: join(root, "input"),
    referenceDir: join(root, "reference"),
    evalsDir: join(root, "evals"),
    skillDir: join(root, "skill"),
    outputDir: join(root, "out")
  });

  const readonlyPaths = [
    () => sandbox.writeFile(join(root, "input", "case.txt"), "mutate"),
    () => sandbox.appendFile(join(root, "reference", "ref.txt"), "mutate"),
    () => sandbox.mkdir(join(root, "evals", "new")),
    () => sandbox.rm(join(root, "skill", "SKILL.md")),
    () => sandbox.cp(join(root, "reference", "ref.txt"), join(root, "input", "copy.txt")),
    () => sandbox.chmod(join(root, "reference", "ref.txt"), 0o600)
  ];

  for (const action of readonlyPaths) {
    await expect(action()).rejects.toMatchObject({ code: "EROFS" });
  }

  await sandbox.writeFile(join(sandbox.outputDir, "result.txt"), "ok");
  await expect(readFile(join(sandbox.outputDir, "result.txt"), "utf8")).resolves.toBe("ok");
});

test("runEval maps eval type to role and target skill through config", async () => {
  const root = await tempProject();
  await writeFixture(root, securityConfig, securityEvals);
  const calls: unknown[] = [];
  const agent: EvalAgent = {
    async run(request) {
      calls.push(request);
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 1, 2);
    }
  };

  await runEval(
    {
      config: securityConfig,
      projectRoot: root,
      evalCase: securityEvals.evals[0],
      baseline: true,
      outputRoot: join(root, "workspace", "baseline", "outputs")
    },
    agent
  );
  await runEval(
    {
      config: securityConfig,
      projectRoot: root,
      evalCase: securityEvals.evals[1],
      baseline: false,
      targetSkillDir: join(root, "skills", "secure-authoring"),
      outputRoot: join(root, "workspace", "iterations", "1")
    },
    agent
  );

  expect(calls).toHaveLength(2);
  expect((calls[0] as any).role).toBe("security-auditor");
  expect((calls[0] as any).targetSkill).toBeUndefined();
  expect((calls[0] as any).sandbox.mounts.some((mount: any) => mount.target === "/skill")).toBe(false);
  expect((calls[1] as any).role).toBe("secure-author");
  expect((calls[1] as any).targetSkill).toBe("secure-authoring");
  expect((calls[1] as any).sandbox.mounts.find((mount: any) => mount.target === "/skill").readOnly).toBe(true);
});

test("runWithConcurrency respects the configured limit", async () => {
  let active = 0;
  let maxActive = 0;
  await runWithConcurrency([1, 2, 3, 4], 2, async (item) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return item;
  });

  expect(maxActive).toBeLessThanOrEqual(2);
});

test("orchestrator requires complete artefacts when started with withBaseline", async () => {
  const reuseRoot = await tempProject();
  await writeFixture(reuseRoot, syntheticConfig, syntheticEvals);
  await mkdir(join(reuseRoot, "workspace", "baseline", "notes-001", "input"), { recursive: true });
  await mkdir(join(reuseRoot, "workspace", "baseline", "notes-001", "output"), { recursive: true });
  await writeFile(
    join(reuseRoot, "workspace", "baseline", "scores-0.json"),
    JSON.stringify(score("notes-001", "summarise-changelog", "summarise"))
  );
  await writeFile(join(reuseRoot, "workspace", "baseline", "notes-001", "task.md"), "Task");
  await writeFile(join(reuseRoot, "workspace", "baseline", "notes-001", "input", "SPEC.md"), "Input");
  await writeFile(join(reuseRoot, "workspace", "baseline", "notes-001", "output", "SPEC.md"), "Output");
  await writeFile(join(reuseRoot, "workspace", "baseline", "summary.json"), JSON.stringify({ average: 1 }));
  await writeFile(join(reuseRoot, "workspace", "baseline", "summary-summarise.json"), JSON.stringify({ average: 1 }));
  await writeFile(join(reuseRoot, "workspace", "baseline", "analysis-summarise.md"), "Analysis");

  const reused = await orchestrateBaseline({ projectRoot: reuseRoot, withBaseline: true });
  expect(reused.events[1]).toMatchObject({ type: "baseline-imported", scores: 1 });
  expect(reused.completedIterations).toBe(0);

  const missingRoot = await tempProject();
  await writeFixture(missingRoot, syntheticConfig, syntheticEvals);
  await expect(orchestrateBaseline({ projectRoot: missingRoot, withBaseline: true })).rejects.toThrow(
    /--with-baseline/
  );
});

test("orchestrator generates initial baseline by default without counting it as an iteration", async () => {
  const generateRoot = await tempProject();
  await writeFixture(generateRoot, syntheticConfig, syntheticEvals);
  const agent: EvalAgent = {
    async run(request) {
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id);
    }
  };
  const generated = await orchestrateBaseline({ projectRoot: generateRoot, agent });
  expect(generated.events[1]).toMatchObject({ type: "baseline-started", countsTowardIterations: false });
  expect(generated.events[2]).toMatchObject({ type: "baseline-generated", scores: 1 });
  expect(generated.completedIterations).toBe(0);
  expect(generated.events.at(-1)).toMatchObject({ type: "research-loop-ready", completedIterations: 0 });
  await expect(readFile(join(generateRoot, "workspace", "baseline", "scores-0.json"), "utf8")).resolves.toContain(
    "notes-001"
  );
});

test("orchestrator runs research iterations until target score is reached", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const seedSkill = join(root, "seed-skill");
  await mkdir(seedSkill, { recursive: true });
  await writeFile(join(seedSkill, "SKILL.md"), "# Release Summary\n");

  let evalRuns = 0;
  const agent: EvalAgent = {
    async run(request) {
      if (!request.targetSkill) {
        return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.2);
      }
      evalRuns++;
      const total = evalRuns === 1 ? 0.5 : 0.9;
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, total);
    }
  };
  const researcher: SkillResearcher = {
    async improve(request) {
      await copySkillSnapshot(request.previousSkillDir, request.candidateSkillDir);
      await writeFile(join(request.candidateSkillDir, `iteration-${request.iteration}.txt`), "candidate\n");
    }
  };

  const result = await orchestrateBaseline({
    projectRoot: root,
    agent,
    researcher,
    runResearch: true,
    seedSkillDir: seedSkill
  });

  expect(result.completedIterations).toBe(2);
  expect(result.bestIteration?.iteration).toBe(2);
  expect(result.aggregate.overall.normalizedScore).toBe(0.9);
  expect(result.events.at(-1)).toMatchObject({ type: "target-score-reached", iteration: 2 });
  await expect(readFile(join(root, "workspace", "iterations", "2", "scores-0.json"), "utf8")).resolves.toContain(
    "notes-001"
  );
  await expect(readFile(join(root, "workspace", "iterations", "2", "skill", "iteration-2.txt"), "utf8")).resolves.toBe(
    "candidate\n"
  );
});

test("orchestrator stops research at max iterations and keeps the best candidate", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const seedSkill = join(root, "seed-skill");
  await mkdir(seedSkill, { recursive: true });
  await writeFile(join(seedSkill, "SKILL.md"), "# Release Summary\n");

  let candidateRuns = 0;
  const agent: EvalAgent = {
    async run(request) {
      if (!request.targetSkill) {
        return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.2);
      }
      candidateRuns++;
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, candidateRuns === 2 ? 0.6 : 0.4);
    }
  };
  const researcher: SkillResearcher = {
    async improve(request) {
      await copySkillSnapshot(request.previousSkillDir, request.candidateSkillDir);
    }
  };

  const result = await orchestrateBaseline({
    projectRoot: root,
    agent,
    researcher,
    runResearch: true,
    seedSkillDir: seedSkill
  });

  expect(result.completedIterations).toBe(syntheticConfig.max_iterations);
  expect(result.bestIteration?.iteration).toBe(2);
  expect(result.aggregate.overall.normalizedScore).toBe(0.6);
  expect(result.events.at(-1)).toMatchObject({
    type: "max-iterations-reached",
    completedIterations: syntheticConfig.max_iterations
  });
});
