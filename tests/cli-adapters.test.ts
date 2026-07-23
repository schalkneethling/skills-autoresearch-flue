import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileScoreAgent, SnapshotResearcher } from "../src/adapters.js";
import { main, parseCliArgs } from "../src/cli.js";
import { trackForEval } from "../src/project.js";
import {
  securityConfig,
  securityEvals,
  score,
  syntheticConfig,
  syntheticEvals,
  tempProject,
  writeFixture
} from "./helpers.js";

test("parseCliArgs validates currently required adapters", () => {
  expect(parseCliArgs(["--project", "/tmp/project", "--with-baseline"])).toMatchObject({
    projectRoot: "/tmp/project",
    withBaseline: true,
    runResearch: false
  });
  expect(parseCliArgs(["--score-dir", "/tmp/scores", "--research", "--seed-skill", "/tmp/skill"])).toMatchObject({
    scoreDir: "/tmp/scores",
    runResearch: true,
    seedSkillDir: "/tmp/skill"
  });
  expect(parseCliArgs(["--score-dir", "/tmp/scores", "--research", "--guidance-skill", "/tmp/guidance"])).toMatchObject(
    {
      guidanceSkillDir: "/tmp/guidance"
    }
  );
  expect(parseCliArgs(["--model-client", "anthropic", "--research"])).toMatchObject({
    modelClient: "anthropic",
    runResearch: true
  });
  expect(parseCliArgs(["--model-client", "anthropic", "--budget-usd", "0.25"])).toMatchObject({
    budgetUsd: 0.25
  });
  expect(parseCliArgs(["--score-dir", "/tmp/scores", "--research", "--force-research"])).toMatchObject({
    forceResearch: true,
    runResearch: true
  });
  expect(parseCliArgs(["--score-dir", "/tmp/scores", "--research", "--resume"])).toMatchObject({
    resume: true,
    runResearch: true
  });
  expect(parseCliArgs(["--resume"])).toMatchObject({ resume: true });
  expect(parseCliArgs(["--resume", "--research"])).toMatchObject({ resume: true, runResearch: true });
  expect(parseCliArgs(["--with-baseline", "--with-cleanup"])).toMatchObject({ withCleanup: true });
  expect(parseCliArgs(["--with-baseline", "--verbose", "--no-run-log"])).toMatchObject({
    verbose: true,
    writeRunLog: false
  });
  expect(() => parseCliArgs(["--resume", "--with-cleanup"])).toThrow(/either --resume or --with-cleanup/);
  expect(() => parseCliArgs([])).toThrow(/--score-dir or --model-client/);
  expect(() => parseCliArgs(["--with-baseline", "--research"])).toThrow(
    /Research iterations require --score-dir or --model-client/
  );
  expect(() => parseCliArgs(["--score-dir", "/tmp/scores", "--model-client", "anthropic"])).toThrow(/either/);
  expect(() => parseCliArgs(["--model-client", "unknown"])).toThrow(/Unsupported model client/);
  expect(() => parseCliArgs(["--model-client", "anthropic", "--budget-usd=-1"])).toThrow(/non-negative/);
  expect(() => parseCliArgs(["--model-client", "anthropic", "--budget-usd", "nope"])).toThrow(/non-negative/);
  expect(() => parseCliArgs(["--project"])).toThrow(/argument missing/);
});

test("JSON mode emits only JSON and includes the run-log path conditionally", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const root = await tempProject();
    await writeFixture(root, syntheticConfig, syntheticEvals);
    const scoreDir = join(root, "scores");
    await mkdir(scoreDir, { recursive: true });
    await writeFile(
      join(scoreDir, "notes-001.json"),
      JSON.stringify(score("notes-001", "summarise-changelog", "summarise"))
    );

    await main(["--project", root, "--score-dir", scoreDir, "--json"]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toMatchObject({ runLogPath: expect.any(String) });

    log.mockClear();
    const unloggedRoot = await tempProject();
    await writeFixture(unloggedRoot, syntheticConfig, syntheticEvals);
    await main(["--project", unloggedRoot, "--score-dir", scoreDir, "--json", "--no-run-log"]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).not.toHaveProperty("runLogPath");
  } finally {
    log.mockRestore();
  }
});

test("FileScoreAgent returns eval scores from explicit files", async () => {
  const root = await tempProject();
  const scoreDir = join(root, "scores");
  await mkdir(scoreDir, { recursive: true });
  await writeFile(join(scoreDir, "xss-001.json"), JSON.stringify(score("xss-001", "detect-and-fix", "audit", 2, 2)));

  const evalCase = securityEvals.evals[0];
  const agent = new FileScoreAgent({ scoreDir });
  const result = await agent.run({
    evalCase,
    track: trackForEval(securityConfig, evalCase.eval_type),
    role: "security-auditor",
    model: { provider: "anthropic", name: "claude-sonnet-4-6" },
    sandbox: {} as never
  });

  expect(result.total_score).toBe(2);
});

test("SnapshotResearcher copies the previous skill and writes iteration metadata", async () => {
  const root = await tempProject();
  const previousSkillDir = join(root, "previous");
  const candidateSkillDir = join(root, "candidate");
  await mkdir(previousSkillDir, { recursive: true });
  await writeFile(join(previousSkillDir, "SKILL.md"), "# Skill\n");

  const researcher = new SnapshotResearcher();
  await researcher.improve({
    project: {} as never,
    iteration: 1,
    previousSkillDir,
    candidateSkillDir,
    baselineScores: [],
    previousScores: [],
    previousAggregate: {
      tracks: [],
      overall: {
        score: 0,
        maxScore: 1,
        normalizedScore: syntheticConfig.target_score,
        evalCount: 0
      }
    }
  });

  await expect(readFile(join(candidateSkillDir, "SKILL.md"), "utf8")).resolves.toBe("# Skill\n");
  await expect(readFile(join(candidateSkillDir, ".autoresearch-iteration.json"), "utf8")).resolves.toContain(
    "previousNormalizedScore"
  );
});
