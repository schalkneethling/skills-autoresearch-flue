import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GENERATED_SKILL_FILES } from "./project-layout.js";
import type { ModelRequest, ScriptValidationResult } from "./model-agent.js";
import type { SkillResearchRequest } from "./orchestrator.js";
import type { SkillResearchPatch } from "./schemas.js";

export async function persistTranscript(path: string, request: ModelRequest, response: unknown): Promise<void> {
  await withArtifactStage(`write transcript ${path}`, async () => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ request, response }, null, 2)}\n`, { flag: "wx" });
  });
}

export interface ResearchArtifactOperations {
  validatePatch(skillDir: string, patch: SkillResearchPatch): void;
  applyPatch(skillDir: string, patch: SkillResearchPatch): Promise<void>;
  validateScripts(skillDir: string, patch: SkillResearchPatch): Promise<ScriptValidationResult[]>;
  appendLedger(path: string | undefined, iteration: number, patch: SkillResearchPatch): Promise<void>;
  formatSummary(patch: SkillResearchPatch, validations: ScriptValidationResult[]): string;
}

export async function persistResearchArtifact(
  request: SkillResearchRequest,
  modelRequest: ModelRequest,
  patch: SkillResearchPatch,
  response: unknown,
  transcriptFileName: string,
  operations: ResearchArtifactOperations
): Promise<void> {
  const label = `research iteration ${request.iteration} at ${request.candidateSkillDir}`;
  await withArtifactStage(`${label}: validate patch`, () => operations.validatePatch(request.candidateSkillDir, patch));
  await withArtifactStage(`${label}: copy previous skill`, () =>
    cp(request.previousSkillDir, request.candidateSkillDir, { recursive: true, errorOnExist: true, force: false })
  );
  await withArtifactStage(`${label}: remove generated skill files`, () =>
    Promise.all(GENERATED_SKILL_FILES.map((fileName) => rm(join(request.candidateSkillDir, fileName), { force: true })))
  );
  await withArtifactStage(`${label}: apply patch`, () => operations.applyPatch(request.candidateSkillDir, patch));
  const validations = await withArtifactStage(`${label}: validate generated scripts`, () =>
    operations.validateScripts(request.candidateSkillDir, patch)
  );
  await withArtifactStage(`${label}: append guidance ledger`, () =>
    operations.appendLedger(request.guidanceLedgerPath, request.iteration, patch)
  );
  await withArtifactStage(`${label}: write research summary`, () =>
    writeFile(join(request.candidateSkillDir, "RESEARCH.md"), operations.formatSummary(patch, validations), {
      flag: "wx"
    })
  );
  await withArtifactStage(`${label}: persist transcript`, () =>
    persistTranscript(join(request.candidateSkillDir, transcriptFileName), modelRequest, response)
  );
}

export async function withArtifactStage<T>(stage: string, operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`Failed to ${stage}.${detail}`, { cause: error });
  }
}
