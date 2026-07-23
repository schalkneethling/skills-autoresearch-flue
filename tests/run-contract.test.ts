import { normalizeRunOptions } from "../src/run-options.js";
import { GENERATED_RESEARCH_ARTIFACTS, projectLayout } from "../src/project-layout.js";
import { persistResearchArtifact } from "../src/artifact-lifecycle.js";
import { join } from "node:path";

test("run options normalize both adapter payload shapes into one contract", () => {
  const cli = normalizeRunOptions({
    projectRoot: "/tmp/project",
    withBaseline: true,
    runResearch: true
  });
  const flue = normalizeRunOptions({
    projectRoot: "/tmp/project",
    withBaseline: true,
    runResearch: true,
    forceResearch: false,
    resume: false,
    withCleanup: false,
    budgetUsd: 0.25
  });

  expect(cli).toEqual({
    projectRoot: "/tmp/project",
    withBaseline: true,
    runResearch: true,
    forceResearch: false,
    resume: false,
    withCleanup: false
  });
  expect(flue).toEqual({ ...cli, budgetUsd: 0.25 });
  expect(normalizeRunOptions({ resume: true, withCleanup: true })).toMatchObject({
    resume: true,
    withCleanup: true
  });
});

test("project layout identifies only generated research state for cleanup", () => {
  const layout = projectLayout("/tmp/project");
  expect(GENERATED_RESEARCH_ARTIFACTS.map((artifact) => join(layout.workspaceDir, artifact))).toEqual([
    join("/tmp/project", "workspace", "iterations"),
    join("/tmp/project", "workspace", "resume-backups"),
    join("/tmp/project", "workspace", "guidance-ledger.json")
  ]);
  expect(layout.baselineDir).toBe(join("/tmp/project", "workspace", "baseline"));
});

test("research artifact lifecycle identifies the failed stage and preserves its cause", async () => {
  const cause = new Error("invalid patch");
  try {
    await persistResearchArtifact(
      {
        iteration: 2,
        candidateSkillDir: "/tmp/candidate",
        previousSkillDir: "/tmp/previous"
      } as never,
      {} as never,
      {} as never,
      {},
      ".autoresearch-transcript.json",
      {
        validatePatch: () => {
          throw cause;
        },
        applyPatch: async () => undefined,
        validateScripts: async () => [],
        appendLedger: async () => undefined,
        formatSummary: () => ""
      }
    );
    throw new Error("Expected lifecycle to fail");
  } catch (error) {
    expect(error).toMatchObject({
      message: "Failed to research iteration 2 at /tmp/candidate: validate patch. invalid patch",
      cause
    });
  }
});
