import { join } from "node:path";

/**
 * Canonical locations for generated run artifacts. Keep public paths stable by
 * changing the values here rather than reconstructing them at call sites.
 */
export const GENERATED_RESEARCH_ARTIFACTS = ["iterations", "resume-backups", "guidance-ledger.json"] as const;

export const RESEARCH_TRANSCRIPTS = [
  ".autoresearch-flue-transcript.json",
  ".autoresearch-transcript.json",
  ".autoresearch-iteration.json"
] as const;
export const PRODUCER_TRANSCRIPTS = ["producer-flue-transcript.json", "producer-transcript.json"] as const;
export const JUDGE_TRANSCRIPTS = ["judge-flue-transcript.json", "judge-transcript.json"] as const;
export const GENERATED_SKILL_FILES = ["RESEARCH.md", ...RESEARCH_TRANSCRIPTS] as const;

export interface ProjectLayout {
  root: string;
  workspaceDir: string;
  baselineDir: string;
  iterationsDir: string;
  resumeBackupsDir: string;
  guidanceLedgerPath: string;
  costSummaryPath: string;
  iterationDir(iteration: number): string;
  iterationSkillDir(iteration: number): string;
  iterationOutputDir(iteration: number, evalId?: string): string;
  iterationSummaryPath(iteration: number): string;
  researchWorkspaceDir(iteration: number): string;
}

export function projectLayout(root: string): ProjectLayout {
  const workspaceDir = join(root, "workspace");
  const iterationsDir = join(workspaceDir, "iterations");
  return {
    root,
    workspaceDir,
    baselineDir: join(workspaceDir, "baseline"),
    iterationsDir,
    resumeBackupsDir: join(workspaceDir, "resume-backups"),
    guidanceLedgerPath: join(workspaceDir, "guidance-ledger.json"),
    costSummaryPath: join(workspaceDir, "cost-summary.json"),
    iterationDir: (iteration) => join(iterationsDir, String(iteration)),
    iterationSkillDir: (iteration) => join(iterationsDir, String(iteration), "skill"),
    iterationOutputDir: (iteration, evalId) =>
      evalId
        ? join(iterationsDir, String(iteration), "outputs", evalId)
        : join(iterationsDir, String(iteration), "outputs"),
    iterationSummaryPath: (iteration) => join(iterationsDir, String(iteration), "summary.json"),
    researchWorkspaceDir: (iteration) => join(workspaceDir, ".phase-workspaces", `research-${iteration}`)
  };
}
