import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
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
  expect(reused.events[2]).toMatchObject({ type: "baseline-imported", scores: 1 });
  expect(reused.completedIterations).toBe(0);

  const missingRoot = await tempProject();
  await writeFixture(missingRoot, syntheticConfig, syntheticEvals);
  await expect(orchestrateBaseline({ projectRoot: missingRoot, withBaseline: true })).rejects.toThrow(
    /--with-baseline/
  );
});

test("orchestrator rejects missing configured judge role before baseline work", async () => {
  const root = await tempProject();
  await writeFixture(
    root,
    {
      ...syntheticConfig,
      roles: {
        ...syntheticConfig.roles,
        judge: "release-notes-judge"
      }
    },
    syntheticEvals
  );

  await expect(orchestrateBaseline({ projectRoot: root, withBaseline: true })).rejects.toThrow(
    new RegExp(
      [
        "Configured Flue roles are not registered.",
        "release-notes-judge: roles.judge",
        "Available roles: eval-judge, skill-builder, task-producer",
        "Define roles as markdown files in roles/ or .flue/roles/."
      ].join("(.|\n)*")
    )
  );
  await expect(stat(join(root, "workspace", "baseline"))).rejects.toMatchObject({
    code: "ENOENT"
  });
});

test("orchestrator rejects missing producer track role before running evals", async () => {
  const root = await tempProject();
  await writeFixture(
    root,
    {
      ...syntheticConfig,
      tracks: [
        {
          ...syntheticConfig.tracks[0],
          role: "release-editor"
        }
      ]
    },
    syntheticEvals
  );
  let agentRuns = 0;
  const agent: EvalAgent = {
    async run(request) {
      agentRuns++;
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id);
    }
  };

  await expect(orchestrateBaseline({ projectRoot: root, agent })).rejects.toThrow(/release-editor: tracks\[0\]\.role/);
  expect(agentRuns).toBe(0);
  await expect(stat(join(root, "workspace", "baseline"))).rejects.toMatchObject({
    code: "ENOENT"
  });
});

test("orchestrator accepts valid configured Flue roles", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  let agentRuns = 0;
  const agent: EvalAgent = {
    async run(request) {
      agentRuns++;
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id);
    }
  };

  const result = await orchestrateBaseline({ projectRoot: root, agent });

  expect(agentRuns).toBe(1);
  expect(result.events[2]).toMatchObject({ type: "baseline-started" });
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
  expect(generated.events[2]).toMatchObject({
    type: "baseline-started",
    countsTowardIterations: false
  });
  expect(generated.events).toContainEqual({ type: "baseline-generated", scores: 1 });
  expect(generated.completedIterations).toBe(0);
  expect(generated.events.at(-1)).toMatchObject({
    type: "research-loop-ready",
    completedIterations: 0
  });
  await expect(readFile(join(generateRoot, "workspace", "baseline", "scores-0.json"), "utf8")).resolves.toContain(
    "notes-001"
  );
});

test("orchestrator skips research when the baseline already reaches target score", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const agent: EvalAgent = {
    async run(request) {
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.95);
    }
  };
  const researcher: SkillResearcher = {
    async improve() {
      throw new Error("researcher should not run when baseline reaches target");
    }
  };

  const result = await orchestrateBaseline({
    projectRoot: root,
    agent,
    researcher,
    runResearch: true
  });

  expect(result.completedIterations).toBe(0);
  expect(result.iterations).toEqual([]);
  expect(result.aggregate.overall.normalizedScore).toBe(0.95);
  expect(result.events.at(-1)).toMatchObject({
    type: "baseline-target-score-reached",
    normalizedScore: 0.95,
    targetScore: syntheticConfig.target_score
  });
  await expect(stat(join(root, "workspace", "iterations", "1"))).rejects.toMatchObject({
    code: "ENOENT"
  });
});

test("orchestrator can force research when the baseline already reaches target score", async () => {
  const root = await tempProject();
  const config = { ...syntheticConfig, max_iterations: 1 };
  await writeFixture(root, config, syntheticEvals);
  const seedSkill = join(root, "seed-skill");
  await mkdir(seedSkill, { recursive: true });
  await writeFile(join(seedSkill, "SKILL.md"), "# Release Summary\n");

  const agent: EvalAgent = {
    async run(request) {
      return request.targetSkill
        ? score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.96)
        : score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.95);
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
    forceResearch: true,
    seedSkillDir: seedSkill
  });

  expect(result.completedIterations).toBe(1);
  expect(result.events.some((event) => event.type === "baseline-target-score-reached")).toBe(false);
  expect(result.events.at(-1)).toMatchObject({ type: "target-score-reached", iteration: 1 });
  await expect(stat(join(root, "workspace", "iterations", "1", "skill"))).resolves.toBeTruthy();
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

test("orchestrator keeps iterating when aggregate target has a baseline regression", async () => {
  const root = await tempProject();
  const config = {
    ...syntheticConfig,
    target_score: 0.85,
    max_iterations: 2,
    tracks: [
      {
        ...syntheticConfig.tracks[0],
        eval_type: "two-case-eval"
      }
    ]
  };
  const evals = {
    evals: [
      {
        ...syntheticEvals.evals[0],
        id: "case-a",
        eval_type: "two-case-eval"
      },
      {
        ...syntheticEvals.evals[0],
        id: "case-b",
        eval_type: "two-case-eval"
      }
    ]
  };
  await writeFixture(root, config, evals);
  const seedSkill = join(root, "seed-skill");
  await mkdir(seedSkill, { recursive: true });
  await writeFile(join(seedSkill, "SKILL.md"), "# Release Summary\n");

  const agent: EvalAgent = {
    async run(request) {
      if (!request.targetSkill) {
        return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.8);
      }
      const iteration = request.sandbox.outputDir.includes(join("iterations", "1")) ? 1 : 2;
      if (iteration === 1) {
        return score(
          request.evalCase.id,
          request.evalCase.eval_type,
          request.track.id,
          request.evalCase.id === "case-a" ? 1 : 0.7
        );
      }
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.9);
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

  expect(result.completedIterations).toBe(2);
  expect(result.events).toContainEqual({
    type: "target-score-blocked-by-regression",
    iteration: 1,
    normalizedScore: 0.85,
    targetScore: 0.85,
    regressions: [{ evalId: "case-b", baselineScore: 0.8, candidateScore: 0.7 }]
  });
  expect(result.events.at(-1)).toMatchObject({ type: "target-score-reached", iteration: 2 });
});

test("orchestrator can start research from an empty skill while using the seed as guidance", async () => {
  const root = await tempProject();
  const seedSkill = join(root, "seed-skill");
  const config = { ...syntheticConfig, origin_skill: seedSkill, research_start: "empty" as const };
  await writeFixture(root, config, syntheticEvals);
  await mkdir(seedSkill, { recursive: true });
  await writeFile(join(seedSkill, "SKILL.md"), "# Seed Guidance\n");

  let evalRuns = 0;
  const previousSkillDirs: string[] = [];
  const guidanceSkillDirs: Array<string | undefined> = [];
  const agent: EvalAgent = {
    async run(request) {
      if (!request.targetSkill) {
        return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.2);
      }
      evalRuns++;
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, evalRuns === 1 ? 0.5 : 0.9);
    }
  };
  const researcher: SkillResearcher = {
    async improve(request) {
      previousSkillDirs.push(request.previousSkillDir);
      guidanceSkillDirs.push(request.guidanceSkillDir);
      await copySkillSnapshot(request.previousSkillDir, request.candidateSkillDir);
      await writeFile(join(request.candidateSkillDir, `iteration-${request.iteration}.txt`), "candidate\n");
    }
  };

  const result = await orchestrateBaseline({
    projectRoot: root,
    agent,
    researcher,
    runResearch: true
  });

  expect(result.completedIterations).toBe(2);
  expect(previousSkillDirs[0]).toBe(join(root, "workspace", "empty-skill"));
  expect(await readdir(previousSkillDirs[0])).toEqual([]);
  expect(previousSkillDirs[1]).toBe(join(root, "workspace", "iterations", "1", "skill"));
  expect(guidanceSkillDirs).toEqual([seedSkill, seedSkill]);
  await expect(stat(join(root, "workspace", "iterations", "1", "skill", "SKILL.md"))).rejects.toMatchObject({
    code: "ENOENT"
  });
});

test("orchestrator resolves config skill paths relative to the project root", async () => {
  const root = await tempProject();
  const seedSkill = join(root, "skills", "security-audit");
  const guidanceSkill = join(root, "skills", "guidance-reference");
  const config = {
    ...syntheticConfig,
    origin_skill: "skills/security-audit",
    guidance_skill: "skills/guidance-reference",
    research_start: "empty" as const,
    max_iterations: 1
  };
  await writeFixture(root, config, syntheticEvals);
  await mkdir(seedSkill, { recursive: true });
  await mkdir(guidanceSkill, { recursive: true });
  await writeFile(join(seedSkill, "SKILL.md"), "# Seed\n");
  await writeFile(join(guidanceSkill, "SKILL.md"), "# Guidance\n");

  let previousSkillDir = "";
  let guidanceSkillDir = "";
  const agent: EvalAgent = {
    async run(request) {
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, request.targetSkill ? 0.9 : 0.2);
    }
  };
  const researcher: SkillResearcher = {
    async improve(request) {
      previousSkillDir = request.previousSkillDir;
      guidanceSkillDir = request.guidanceSkillDir ?? "";
      await copySkillSnapshot(request.previousSkillDir, request.candidateSkillDir);
      await writeFile(join(request.candidateSkillDir, "SKILL.md"), "# Candidate\n");
    }
  };

  const result = await orchestrateBaseline({
    projectRoot: root,
    agent,
    researcher,
    runResearch: true
  });

  expect(result.completedIterations).toBe(1);
  expect(previousSkillDir).toBe(join(root, "workspace", "empty-skill"));
  expect(guidanceSkillDir).toBe(guidanceSkill);
});

test("orchestrator preserves absolute origin_skill paths", async () => {
  const root = await tempProject();
  const seedSkill = join(root, "absolute-seed");
  await writeFixture(root, { ...syntheticConfig, origin_skill: seedSkill, max_iterations: 1 }, syntheticEvals);
  await mkdir(seedSkill, { recursive: true });
  await writeFile(join(seedSkill, "SKILL.md"), "# Seed\n");

  let previousSkillDir = "";
  const agent: EvalAgent = {
    async run(request) {
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, request.targetSkill ? 0.9 : 0.2);
    }
  };
  const researcher: SkillResearcher = {
    async improve(request) {
      previousSkillDir = request.previousSkillDir;
      await copySkillSnapshot(request.previousSkillDir, request.candidateSkillDir);
    }
  };

  await orchestrateBaseline({
    projectRoot: root,
    agent,
    researcher,
    runResearch: true
  });

  expect(previousSkillDir).toBe(seedSkill);
});

test("orchestrator cleanup removes generated research state and preserves the baseline", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, "iterations", "1"), { recursive: true });
  await mkdir(join(workspace, "resume-backups", "interrupted"), { recursive: true });
  await mkdir(join(workspace, "baseline"), { recursive: true });
  await writeFile(join(workspace, "iterations", "1", "stale.txt"), "stale\n");
  await writeFile(join(workspace, "resume-backups", "interrupted", "stale.txt"), "stale\n");
  await writeFile(join(workspace, "guidance-ledger.json"), "{}\n");
  await writeFile(join(workspace, "baseline", "keep.txt"), "baseline\n");

  const agent: EvalAgent = {
    async run(request) {
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.2);
    }
  };
  const result = await orchestrateBaseline({ projectRoot: root, agent, withCleanup: true });

  for (const path of ["iterations", "resume-backups", "guidance-ledger.json"]) {
    await expect(stat(join(workspace, path))).rejects.toMatchObject({ code: "ENOENT" });
  }
  await expect(readFile(join(workspace, "baseline", "keep.txt"), "utf8")).resolves.toBe("baseline\n");
  expect(result.events).toContainEqual({
    type: "cleanup-completed",
    removed: ["workspace/iterations", "workspace/resume-backups", "workspace/guidance-ledger.json"]
  });
});

test("orchestrator cleanup reports no removals when generated research state is absent", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  const agent: EvalAgent = {
    async run(request) {
      return score(request.evalCase.id, request.evalCase.eval_type, request.track.id, 0.2);
    }
  };

  const result = await orchestrateBaseline({ projectRoot: root, agent, withCleanup: true });

  expect(result.events).toContainEqual({ type: "cleanup-completed", removed: [] });
});

test("orchestrator rejects cleanup with resume", async () => {
  await expect(orchestrateBaseline({ projectRoot: "/unused", resume: true, withCleanup: true })).rejects.toThrow(
    /either resume or withCleanup/
  );
});

test("orchestrator stops with the artifact path when cleanup fails", async () => {
  const root = await tempProject();
  await writeFixture(root, syntheticConfig, syntheticEvals);
  await writeFile(join(root, "workspace"), "not a directory\n");

  await expect(orchestrateBaseline({ projectRoot: root, withCleanup: true })).rejects.toThrow(
    /Failed to inspect generated research artifact workspace\/iterations/
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
