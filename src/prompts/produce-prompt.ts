import { EvalAgentRequest } from "../runner.js";
import { formatFileSet, fencedJson, MountedFile } from "./shared.js";

export interface ProducePromptInput {
  request: EvalAgentRequest;
  workspaceDir: string;
  inputFiles: MountedFile[];
  referenceFiles: MountedFile[];
  skillFiles: MountedFile[];
}

export function buildProducePrompt({
  request,
  workspaceDir,
  inputFiles,
  referenceFiles,
  skillFiles,
}: ProducePromptInput): string {
  return [
    `Run the target skill for "${request.evalCase.title}" (${request.evalCase.id}).`,
    `Eval type: ${request.evalCase.eval_type}`,
    `Track: ${request.track.id}`,
    `Producer role: ${request.role}`,
    request.targetSkill
      ? `Target skill: ${request.targetSkill}`
      : "Baseline run: no target skill is mounted.",
    `Authoritative workspace root: ${workspaceDir}`,
    "Only files under this workspace are authoritative for this producer phase.",
    "Available paths: ./input, ./reference, ./skill when present.",
    "",
    "Eval case JSON:",
    fencedJson(request.evalCase),
    "",
    "Input files:",
    formatFileSet(inputFiles, `producer eval ${request.evalCase.id} input files`),
    "",
    "Reference files:",
    formatFileSet(referenceFiles, `producer eval ${request.evalCase.id} reference files`),
    "",
    "Skill files:",
    formatFileSet(skillFiles, `producer eval ${request.evalCase.id} skill files`),
    "",
    "Produce the concrete eval output files. Do not score your own work.",
    "Return only well-formed JSON with this shape. Do not include markdown, code fences, prose, or XML tags:",
    fencedJson({
      output_files: [
        {
          path: "RESULT.md",
          contents: "The concrete output produced for this eval.",
        },
      ],
    }),
    "Each output_files path must be relative to the eval output directory.",
  ].join("\n");
}
