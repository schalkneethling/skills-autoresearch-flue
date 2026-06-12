import type { FlueSession } from "@flue/runtime/client";
import { ModelCallRole } from "./cost.js";
import {
  applyOutputFiles,
  appendGuidanceLedger,
  buildJudgeModelRequest,
  buildProduceModelRequest,
  buildResearchModelRequest,
  formatResearchSummary,
  parseModelJudgeResponse,
  applySkillResearchPatch,
  validateSkillResearchPatch
} from "./model-agent.js";
import { orchestrateBaseline, OrchestrateOptions, SkillResearcher } from "./orchestrator.js";
import { EvalAgent, EvalAgentRequest } from "./runner.js";
import {
  EvalScore,
  EvalScoreSchema,
  ModelConfig,
  ModelProduceResponseSchema,
  SkillResearchPatchSchema
} from "./schemas.js";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FlueAutoresearchOptions extends Omit<OrchestrateOptions, "agent" | "researcher"> {
  session: FlueSession;
}

const PRODUCER_AGENT = "producer";
const JUDGE_AGENT = "judge";
const RESEARCHER_AGENT = "researcher";

export class FlueEvalAgent implements EvalAgent {
  readonly #session: FlueSession;

  constructor(session: FlueSession) {
    this.#session = session;
  }

  async run(request: EvalAgentRequest): Promise<EvalScore> {
    const produceRequest = await buildProduceModelRequest(request);
    request.costTracker?.assertCanStartModelCall();
    const { data: produced } = await this.#session.task(produceRequest.prompt, {
      result: ModelProduceResponseSchema,
      agent: PRODUCER_AGENT,
      model: toFlueModel(produceRequest.model),
      cwd: produceRequest.workspaceDir
    });
    recordFlueCall(request.costTracker, request.baseline ? "baseline_producer" : "iteration_producer", produceRequest);
    await applyOutputFiles(request.sandbox.outputDir, produced.output_files);
    await writeTranscript(request.sandbox.outputDir, "producer-flue-transcript.json", {
      request: produceRequest,
      response: produced
    });

    const judgeRequest = await buildJudgeModelRequest(request, produced.output_files);
    request.costTracker?.assertCanStartModelCall();
    const { data: score } = await this.#session.task(judgeRequest.prompt, {
      result: EvalScoreSchema,
      agent: JUDGE_AGENT,
      model: toFlueModel(judgeRequest.model),
      cwd: judgeRequest.workspaceDir
    });
    recordFlueCall(request.costTracker, request.baseline ? "baseline_judge" : "iteration_judge", judgeRequest);
    const validated = parseModelJudgeResponse(JSON.stringify(score), request.evalCase, request.track);
    await writeTranscript(request.sandbox.outputDir, "judge-flue-transcript.json", {
      request: judgeRequest,
      response: validated
    });
    return validated;
  }
}

export class FlueSkillResearcher implements SkillResearcher {
  readonly #session: FlueSession;

  constructor(session: FlueSession) {
    this.#session = session;
  }

  async improve(request: Parameters<SkillResearcher["improve"]>[0]): Promise<void> {
    const modelRequest = await buildResearchModelRequest(request);
    request.costTracker?.assertCanStartModelCall();
    const { data: patch } = await this.#session.task(modelRequest.prompt, {
      result: SkillResearchPatchSchema,
      agent: RESEARCHER_AGENT,
      model: toFlueModel(modelRequest.model),
      cwd: modelRequest.workspaceDir
    });
    recordFlueCall(request.costTracker, "researcher", modelRequest);
    validateSkillResearchPatch(request.candidateSkillDir, patch);
    await cp(request.previousSkillDir, request.candidateSkillDir, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    await mkdir(request.candidateSkillDir, { recursive: true });
    await removeGeneratedResearchFiles(request.candidateSkillDir);
    await applySkillResearchPatch(request.candidateSkillDir, patch);
    await appendGuidanceLedger(request.guidanceLedgerPath, request.iteration, patch);
    await writeFile(join(request.candidateSkillDir, "RESEARCH.md"), formatResearchSummary(patch), {
      flag: "wx"
    });
    await writeTranscript(request.candidateSkillDir, ".autoresearch-flue-transcript.json", {
      request: modelRequest,
      response: patch
    });
  }
}

function recordFlueCall(
  tracker: Parameters<SkillResearcher["improve"]>[0]["costTracker"],
  role: ModelCallRole,
  request: { phase?: string; model: ModelConfig }
): void {
  tracker?.recordModelCall({
    role,
    phase: request.phase,
    model: request.model
  });
}

function toFlueModel(model: { provider: string; name: string }): string {
  return `${model.provider}/${model.name}`;
}

export async function runFlueAutoresearch(options: FlueAutoresearchOptions) {
  return orchestrateBaseline({
    ...options,
    modelBacked: true,
    agent: new FlueEvalAgent(options.session),
    researcher: options.runResearch ? new FlueSkillResearcher(options.session) : undefined
  });
}

async function writeTranscript(dir: string, fileName: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

async function removeGeneratedResearchFiles(skillDir: string): Promise<void> {
  await Promise.all(
    ["RESEARCH.md", ".autoresearch-transcript.json", ".autoresearch-flue-transcript.json"].map((fileName) =>
      rm(join(skillDir, fileName), { force: true })
    )
  );
}
