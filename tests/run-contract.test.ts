import { normalizeRunOptions } from "../src/run-options.js";
import { GENERATED_RESEARCH_ARTIFACTS, projectLayout } from "../src/project-layout.js";
import { persistResearchArtifact } from "../src/artifact-lifecycle.js";

test("run options normalize both adapter payload shapes into one contract", () => {
  const cli = normalizeRunOptions({
    projectRoot: "/tmp/project",
    withBaseline: true,
    runResearch: true,
    withCleanup: false,
    budgetUsd: 0.25
  });
  const flue = normalizeRunOptions({
    projectRoot: "/tmp/project",
    withBaseline: true,
    runResearch: true,
    withCleanup: false,
    budgetUsd: 0.25
  });

  expect(cli).toEqual(flue);
  expect(() => normalizeRunOptions({ resume: true, withCleanup: true })).toThrow(/either --resume or --with-cleanup/);
});

test("project layout identifies only generated research state for cleanup", () => {
  const layout = projectLayout("/tmp/project");
  expect(GENERATED_RESEARCH_ARTIFACTS.map((artifact) => `${layout.workspaceDir}/${artifact}`)).toEqual([
    "/tmp/project/workspace/iterations",
    "/tmp/project/workspace/resume-backups",
    "/tmp/project/workspace/guidance-ledger.json"
  ]);
  expect(layout.baselineDir).toBe("/tmp/project/workspace/baseline");
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
