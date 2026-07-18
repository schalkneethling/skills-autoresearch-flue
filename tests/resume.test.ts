import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { aggregateScores } from "../src/aggregate.js";
import {
  createResearchSnapshotManifest,
  findUnexpectedScoreFiles,
  inspectJudgeArtifact,
  inspectProducerArtifact,
  inspectResearchArtifact,
  inspectScoreArtifact,
  inspectSummaryArtifact
} from "../src/resume.js";
import { syntheticConfig, syntheticEvals, score, tempProject } from "./helpers.js";

const evalCase = syntheticEvals.evals[0];
const track = syntheticConfig.tracks[0];

test("inspectScoreArtifact validates the score at the configured eval position", async () => {
  const root = await tempProject();
  const valid = score(evalCase.id, evalCase.eval_type, track.id, 0.6);
  await writeFile(join(root, "scores-0.json"), JSON.stringify(valid));

  await expect(inspectScoreArtifact({ directory: root, index: 0, evalCase, track })).resolves.toEqual({
    status: "complete",
    value: valid
  });
  await expect(inspectScoreArtifact({ directory: root, index: 1, evalCase, track })).resolves.toEqual({
    status: "absent"
  });

  await writeFile(join(root, "scores-1.json"), JSON.stringify({ ...valid, eval_id: "another-eval" }));
  const invalid = await inspectScoreArtifact({ directory: root, index: 1, evalCase, track });
  expect(invalid).toMatchObject({ status: "invalid" });
  expect(invalid.status === "invalid" && invalid.reason).toContain('expected "notes-001"');
});

test("inspectScoreArtifact requires complete, unique, rubric-compatible dimensions", async () => {
  const root = await tempProject();
  const valid = score(evalCase.id, evalCase.eval_type, track.id, 0.6);
  const cases = [
    { dimensions: [], message: "Expected >=1" },
    { dimensions: [...valid.dimensions, valid.dimensions[0]], message: "duplicate dimensions: clarity" },
    { dimensions: [{ ...valid.dimensions[0], max_score: 2 }], message: "max_score 2, expected 1" }
  ];

  for (const [index, candidate] of cases.entries()) {
    await writeFile(join(root, `scores-${index}.json`), JSON.stringify({ ...valid, ...candidate }));
    const artifact = await inspectScoreArtifact({ directory: root, index, evalCase, track });
    expect(artifact).toMatchObject({ status: "invalid" });
    expect(artifact.status === "invalid" && artifact.reason).toContain(candidate.message);
  }

  const twoDimensionEval = {
    ...evalCase,
    scoring_dimensions: [...evalCase.scoring_dimensions, { id: "risk", label: "Risk", max_score: 1 }]
  };
  await writeFile(join(root, "scores-3.json"), JSON.stringify(valid));
  const missing = await inspectScoreArtifact({ directory: root, index: 3, evalCase: twoDimensionEval, track });
  expect(missing).toMatchObject({ status: "invalid" });
  expect(missing.status === "invalid" && missing.reason).toContain("missing dimensions: risk");
});

test("findUnexpectedScoreFiles reports positional score artifacts beyond the eval set", async () => {
  const root = await tempProject();
  await Promise.all(
    ["scores-0.json", "scores-3.json", "scores-2.json", "summary.json"].map((file) => writeFile(join(root, file), "{}"))
  );

  await expect(findUnexpectedScoreFiles(root, 2)).resolves.toEqual(["scores-2.json", "scores-3.json"]);
});

test("inspectResearchArtifact requires a candidate directory and a valid completion marker", async () => {
  const root = await tempProject();
  const skillDir = join(root, "skill");
  await expect(inspectResearchArtifact(skillDir, 1)).resolves.toEqual({ status: "absent" });

  await mkdir(skillDir);
  const partial = await inspectResearchArtifact(skillDir, 1);
  expect(partial).toMatchObject({ status: "incomplete" });
  expect(partial.status === "incomplete" && partial.reason).toContain("without a research completion marker");

  await mkdir(join(skillDir, "skill"));
  await writeFile(join(skillDir, "skill", "SKILL.md"), "# Candidate\n");
  await writeFile(
    join(skillDir, ".autoresearch-flue-transcript.json"),
    JSON.stringify({
      request: { phase: "research iteration 1" },
      response: {
        summary: "Improved candidate",
        guidance: [],
        changes: [{ path: "skill/SKILL.md", contents: "# Candidate\n" }]
      }
    })
  );
  await expect(inspectResearchArtifact(skillDir, 1)).resolves.toEqual({
    status: "complete",
    value: {
      candidateSkillDir: skillDir,
      markerPath: join(skillDir, ".autoresearch-flue-transcript.json")
    }
  });
});

test("inspectResearchArtifact supports the non-model snapshot completion marker", async () => {
  const root = await tempProject();
  const skillDir = join(root, "skill");
  await mkdir(skillDir);
  await writeFile(join(skillDir, "SKILL.md"), "# Candidate\n");
  await writeFile(
    join(skillDir, ".autoresearch-iteration.json"),
    JSON.stringify({ iteration: 2, manifest: await createResearchSnapshotManifest(skillDir) })
  );

  await expect(inspectResearchArtifact(skillDir, 2)).resolves.toMatchObject({ status: "complete" });
  const wrongIteration = await inspectResearchArtifact(skillDir, 1);
  expect(wrongIteration).toMatchObject({ status: "invalid" });
  expect(wrongIteration.status === "invalid" && wrongIteration.reason).toContain("expected 1");

  await writeFile(join(skillDir, ".autoresearch-iteration.json"), JSON.stringify({ iteration: 2 }));
  const missingManifest = await inspectResearchArtifact(skillDir, 2);
  expect(missingManifest).toMatchObject({ status: "invalid" });
  expect(missingManifest.status === "invalid" && missingManifest.reason).toContain("snapshot manifest");
});

test("inspectResearchArtifact rejects candidate files that differ from their marker", async () => {
  const root = await tempProject();
  const transcriptSkillDir = join(root, "transcript-skill");
  await mkdir(transcriptSkillDir);
  await writeFile(join(transcriptSkillDir, "SKILL.md"), "# Changed\n");
  await writeFile(
    join(transcriptSkillDir, ".autoresearch-transcript.json"),
    JSON.stringify({
      request: { phase: "research iteration 1" },
      response: {
        summary: "Candidate",
        changes: [{ path: "SKILL.md", contents: "# Expected\n" }]
      }
    })
  );
  const transcript = await inspectResearchArtifact(transcriptSkillDir, 1);
  expect(transcript).toMatchObject({ status: "invalid" });
  expect(transcript.status === "invalid" && transcript.reason).toContain(
    "declared research contents do not match candidate file"
  );

  await writeFile(
    join(transcriptSkillDir, ".autoresearch-transcript.json"),
    JSON.stringify({
      request: { phase: "research iteration 1" },
      response: {
        summary: "Candidate",
        changes: [{ path: "../outside.md", contents: "outside" }]
      }
    })
  );
  const escaping = await inspectResearchArtifact(transcriptSkillDir, 1);
  expect(escaping).toMatchObject({ status: "invalid" });
  expect(escaping.status === "invalid" && escaping.reason).toContain("outside its directory");

  const snapshotSkillDir = join(root, "snapshot-skill");
  await mkdir(snapshotSkillDir);
  await writeFile(join(snapshotSkillDir, "SKILL.md"), "# Expected\n");
  const manifest = await createResearchSnapshotManifest(snapshotSkillDir);
  await writeFile(join(snapshotSkillDir, ".autoresearch-iteration.json"), JSON.stringify({ iteration: 1, manifest }));
  await writeFile(join(snapshotSkillDir, "SKILL.md"), "# Changed\n");
  const snapshot = await inspectResearchArtifact(snapshotSkillDir, 1);
  expect(snapshot).toMatchObject({ status: "invalid" });
  expect(snapshot.status === "invalid" && snapshot.reason).toContain(
    "snapshot manifest does not match candidate files"
  );
});

test("inspectResearchArtifact requires an exact phase, a valid patch, and a SKILL.md", async () => {
  const root = await tempProject();
  const skillDir = join(root, "skill");
  const markerPath = join(skillDir, ".autoresearch-flue-transcript.json");
  await mkdir(skillDir);
  await writeFile(
    markerPath,
    JSON.stringify({
      request: { phase: "research iteration 2" },
      response: {
        summary: "Candidate",
        changes: [{ path: "SKILL.md", contents: "# Candidate\n" }]
      }
    })
  );

  const wrongPhase = await inspectResearchArtifact(skillDir, 1);
  expect(wrongPhase).toMatchObject({ status: "invalid" });
  expect(wrongPhase.status === "invalid" && wrongPhase.reason).toContain('expected "research iteration 1"');

  await writeFile(
    markerPath,
    JSON.stringify({
      request: { phase: "research iteration 1" },
      response: {
        summary: "Candidate",
        changes: [{ path: "SKILL.md", contents: "# Candidate\n" }]
      }
    })
  );
  const missingSkill = await inspectResearchArtifact(skillDir, 1);
  expect(missingSkill).toMatchObject({ status: "incomplete" });
  expect(missingSkill.status === "incomplete" && missingSkill.reason).toContain("missing candidate file");
});

test.each([
  {
    transcript: "producer-flue-transcript.json",
    response: { output_files: [{ path: "output/index.html", contents: "<h1>Result</h1>" }] }
  },
  {
    transcript: "producer-transcript.json",
    response: JSON.stringify({
      output_files: [{ path: "output/index.html", contents: "<h1>Result</h1>" }]
    })
  }
])("inspectProducerArtifact recovers $transcript output", async ({ transcript, response }) => {
  const root = await tempProject();
  await mkdir(join(root, "output"));
  await writeFile(join(root, "output", "index.html"), "<h1>Result</h1>");
  await writeFile(join(root, transcript), JSON.stringify({ request: { phase: "producer eval notes-001" }, response }));

  await expect(inspectProducerArtifact(root, "notes-001")).resolves.toEqual({
    status: "complete",
    value: {
      transcriptPath: join(root, transcript),
      outputFiles: [{ path: "output/index.html", contents: "<h1>Result</h1>" }]
    }
  });
});

test("inspectProducerArtifact rejects a transcript whose output is missing or changed", async () => {
  const root = await tempProject();
  await writeFile(
    join(root, "producer-flue-transcript.json"),
    JSON.stringify({
      request: { phase: "producer eval notes-001" },
      response: { output_files: [{ path: "RESULT.md", contents: "expected" }] }
    })
  );

  const missing = await inspectProducerArtifact(root, "notes-001");
  expect(missing).toMatchObject({ status: "incomplete" });
  expect(missing.status === "incomplete" && missing.reason).toContain("missing output file");

  await writeFile(join(root, "RESULT.md"), "changed");
  const changed = await inspectProducerArtifact(root, "notes-001");
  expect(changed).toMatchObject({ status: "invalid" });
  expect(changed.status === "invalid" && changed.reason).toContain("does not match persisted");
});

test("inspectProducerArtifact rejects a transcript for another eval", async () => {
  const root = await tempProject();
  await writeFile(join(root, "RESULT.md"), "result");
  await writeFile(
    join(root, "producer-flue-transcript.json"),
    JSON.stringify({
      request: { phase: "producer eval notes-002" },
      response: { output_files: [{ path: "RESULT.md", contents: "result" }] }
    })
  );

  const artifact = await inspectProducerArtifact(root, "notes-001");
  expect(artifact).toMatchObject({ status: "invalid" });
  expect(artifact.status === "invalid" && artifact.reason).toContain('expected "producer eval notes-001"');
});

test.each([
  {
    transcript: "judge-flue-transcript.json",
    response: score(evalCase.id, evalCase.eval_type, track.id, 0.8)
  },
  {
    transcript: "judge-transcript.json",
    response: JSON.stringify(score(evalCase.id, evalCase.eval_type, track.id, 0.8))
  }
])("inspectJudgeArtifact recovers and validates $transcript", async ({ transcript, response }) => {
  const root = await tempProject();
  await writeFile(join(root, transcript), JSON.stringify({ request: { phase: "judge eval notes-001" }, response }));

  await expect(inspectJudgeArtifact(root, evalCase, track)).resolves.toEqual({
    status: "complete",
    value: {
      transcriptPath: join(root, transcript),
      score: score(evalCase.id, evalCase.eval_type, track.id, 0.8)
    }
  });
});

test("inspectJudgeArtifact rejects a mismatched phase or score identity", async () => {
  const root = await tempProject();
  const transcriptPath = join(root, "judge-flue-transcript.json");
  await writeFile(
    transcriptPath,
    JSON.stringify({
      request: { phase: "judge eval notes-002" },
      response: score(evalCase.id, evalCase.eval_type, track.id)
    })
  );
  const wrongPhase = await inspectJudgeArtifact(root, evalCase, track);
  expect(wrongPhase).toMatchObject({ status: "invalid" });
  expect(wrongPhase.status === "invalid" && wrongPhase.reason).toContain('expected "judge eval notes-001"');
});

test("inspectSummaryArtifact distinguishes missing, valid, and stale summaries", async () => {
  const root = await tempProject();
  const summaryPath = join(root, "summary.json");
  const aggregate = aggregateScores(syntheticConfig, [score(evalCase.id, evalCase.eval_type, track.id, 0.6)]);

  await expect(inspectSummaryArtifact(summaryPath, aggregate)).resolves.toEqual({ status: "absent" });
  await writeFile(summaryPath, JSON.stringify(aggregate));
  await expect(inspectSummaryArtifact(summaryPath, aggregate)).resolves.toEqual({
    status: "complete",
    value: aggregate
  });

  const stale = await inspectSummaryArtifact(summaryPath, {
    ...aggregate,
    overall: { ...aggregate.overall, normalizedScore: 0.1 }
  });
  expect(stale).toMatchObject({ status: "invalid" });
  expect(stale.status === "invalid" && stale.reason).toContain("does not match the aggregate recomputed");
});
