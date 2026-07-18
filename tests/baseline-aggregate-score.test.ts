import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { aggregateScores } from "../src/aggregate.js";
import { importBaselineArtefacts } from "../src/baseline.js";
import { parseEvalScore } from "../src/score.js";
import { trackForEval } from "../src/project.js";
import { score, securityConfig, securityEvals, tempProject } from "./helpers.js";

test("imports baseline artefacts and reports missing files without overwriting", async () => {
  const root = await tempProject();
  const baseline = join(root, "workspace", "baseline");
  await mkdir(join(baseline, "eval-1", "input"), { recursive: true });
  await mkdir(join(baseline, "eval-1", "output"), { recursive: true });
  await writeFile(join(baseline, "eval-1", "task.md"), "Task");
  await writeFile(join(baseline, "eval-1", "input", "SPEC.md"), "Input");
  await writeFile(join(baseline, "eval-1", "output", "SPEC.md"), "Output");
  await writeFile(join(baseline, "scores-0.json"), JSON.stringify(score("eval-1", "summarise-changelog", "summarise")));
  await writeFile(join(baseline, "summary.json"), JSON.stringify({ average: 1 }));
  await writeFile(join(baseline, "summary-summarise.json"), JSON.stringify({ average: 1 }));
  await writeFile(join(baseline, "analysis-summarise.md"), "Analysis");

  const imported = await importBaselineArtefacts(baseline, ["eval-1", "eval-2"]);

  expect(imported.scores).toHaveLength(1);
  expect(imported.summaries.summary).toEqual({ average: 1 });
  expect(imported.analyses.summarise).toBe("Analysis");
  expect(imported.evalArtefacts["eval-1"].taskPath).toContain("task.md");
  expect(imported.missing.some((item) => item.includes("eval-2"))).toBe(true);
});

test("imports the real frontend-security baseline fixture", async () => {
  const baseline = resolve("fixtures", "baseline", "frontend-security");
  const imported = await importBaselineArtefacts(baseline, [
    "eval-1",
    "eval-2",
    "eval-3",
    "eval-4",
    "eval-5",
    "eval-6"
  ]);

  expect(imported.missing).toEqual([]);
  expect(imported.scores).toHaveLength(6);
  expect(imported.scores[0]).toMatchObject({
    eval_id: "eval-1",
    eval_type: "detect-and-fix",
    total_score: 3,
    max_score: 3
  });
  expect(imported.scores[4]).toMatchObject({
    eval_id: "eval-5",
    eval_type: "secure-author",
    total_score: 1
  });
  expect(imported.summaries.summary).toMatchObject({ overall_composite: 2.25 });
  expect(imported.summaries["summary-audit"]).toMatchObject({ eval_type: "detect-and-fix" });
  expect(imported.analyses.audit).toContain("audit");
  expect(imported.analyses.authoring).toContain("authoring");
  expect(imported.evalArtefacts["eval-1"].outputDir).toContain(join("eval-1", "output"));
});

test("normalizes legacy baseline score totals and summaries", async () => {
  const baseline = join(await tempProject(), "workspace", "baseline");
  await mkdir(baseline, { recursive: true });
  await writeFile(
    join(baseline, "scores-0.json"),
    JSON.stringify({
      eval_id: 1,
      eval_name: "Named legacy eval",
      eval_type: "legacy",
      composite_score: 2.5,
      scores: { quality: { score: 1, justification: "Imported" } }
    })
  );
  await writeFile(
    join(baseline, "scores-1.json"),
    JSON.stringify({
      eval_id: "custom-eval",
      eval_type: "legacy",
      scores: { quality: { score: 2, justification: "Imported" } }
    })
  );

  const imported = await importBaselineArtefacts(baseline, []);

  expect(imported.scores).toMatchObject([
    {
      eval_id: "eval-1",
      eval_type: "legacy",
      track_id: "legacy",
      total_score: 2.5,
      max_score: 3,
      summary: "Named legacy eval"
    },
    {
      eval_id: "custom-eval",
      eval_type: "legacy",
      track_id: "legacy",
      total_score: 2,
      max_score: 3,
      summary: "Imported custom-eval"
    }
  ]);
});

test("aggregates arbitrary configured tracks", () => {
  const report = aggregateScores(securityConfig, [
    score("xss-001", "detect-and-fix", "audit", 2, 2),
    score("author-001", "secure-author", "authoring", 2, 3)
  ]);

  expect(report.tracks.map((track) => track.trackId)).toEqual(["audit", "authoring"]);
  expect(report.overall.normalizedScore).toBe(0.8);
});

test("aggregates by track id before falling back to eval type", () => {
  const report = aggregateScores(securityConfig, [
    score("audit-001", "detect-and-fix", "audit", 2, 2),
    score("legacy-001", "detect-and-fix", undefined as unknown as string, 1, 2),
    score("other-001", "detect-and-fix", "other", 2, 2)
  ]);

  expect(report.tracks.find((track) => track.trackId === "audit")).toMatchObject({
    score: 3,
    maxScore: 4,
    evalCount: 2
  });
  expect(report.overall.evalCount).toBe(2);
});

test("parses judge score JSON and rejects unknown dimensions", () => {
  const evalCase = securityEvals.evals[0];
  const track = trackForEval(securityConfig, evalCase.eval_type);
  const response = JSON.stringify({
    eval_id: "xss-001",
    eval_type: "detect-and-fix",
    track_id: "audit",
    total_score: 2,
    max_score: 2,
    dimensions: [{ id: "finding", score: 2, max_score: 2, rationale: "Found it" }],
    summary: "Pass"
  });

  expect(parseEvalScore(response, evalCase, track).total_score).toBe(2);

  const bad = response.replace("finding", "unknown");
  expect(() => parseEvalScore(bad, evalCase, track)).toThrow(/unknown dimensions/);
  expect(() => parseEvalScore(`\`\`\`json\n${response}\n\`\`\``, evalCase, track)).toThrow(/not valid JSON/);
});
