import { EvalAgentRequest } from "../runner.js";
import { formatFileSet, fencedJson, MountedFile } from "./shared.js";

export interface JudgePromptInput {
  request: EvalAgentRequest;
  workspaceDir: string;
  referenceFiles: MountedFile[];
  rubricFiles: MountedFile[];
  workspaceOutputFiles: MountedFile[];
}

export function buildJudgePrompt({
  request,
  workspaceDir,
  referenceFiles,
  rubricFiles,
  workspaceOutputFiles
}: JudgePromptInput): string {
  // Base judge behavior lives in the Flue subagent profile at .flue/profiles.ts.
  return [
    `Judge output for "${request.evalCase.title}" (${request.evalCase.id}).`,
    `Eval type: ${request.evalCase.eval_type}`,
    `Track: ${request.track.id}`,
    `Judge role: ${request.modelRoles?.judge ?? "judge"}`,
    `Authoritative workspace root: ${workspaceDir}`,
    "Only files under this workspace are authoritative for this judge phase.",
    "Available paths: ./evals, ./reference, ./output.",
    "",
    "Eval case JSON:",
    fencedJson(request.evalCase),
    "",
    "Rubric files:",
    formatFileSet(rubricFiles, `judge eval ${request.evalCase.id} rubric files`),
    "",
    "Reference files:",
    formatFileSet(referenceFiles, `judge eval ${request.evalCase.id} reference files`),
    "",
    "Producer output files:",
    formatFileSet(workspaceOutputFiles, `judge eval ${request.evalCase.id} producer output files`),
    "",
    "Score only the producer output. Do not award credit for requirements merely stated in the skill instructions.",
    "Return only well-formed JSON matching the EvalScore schema. Do not include markdown, code fences, prose, or XML tags:",
    fencedJson({
      eval_id: request.evalCase.id,
      eval_type: request.evalCase.eval_type,
      track_id: request.track.id,
      total_score: 0,
      max_score: request.evalCase.scoring_dimensions.reduce((sum, dimension) => sum + dimension.max_score, 0),
      dimensions: request.evalCase.scoring_dimensions.map((dimension) => ({
        id: dimension.id,
        score: 0,
        max_score: dimension.max_score,
        rationale: "Rationale grounded only in the producer output."
      })),
      summary: "Concise scoring summary."
    })
  ].join("\n");
}
