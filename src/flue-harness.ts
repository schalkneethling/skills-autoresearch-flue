import type { FlueSession } from "@flue/runtime";
import { join } from "node:path";
import { ModelCallRole, ModelRunCostSummary } from "./cost.js";
import {
  applyOutputFiles,
  buildJudgeModelRequest,
  buildProduceModelRequest,
  buildResearchModelRequest,
  parseModelJudgeResponse,
  researchArtifactOperations
} from "./model-agent.js";
import { persistResearchArtifact, persistTranscript } from "./artifact-lifecycle.js";
import { orchestrateBaseline, OrchestrateOptions, SkillResearcher } from "./orchestrator.js";
import { EvalAgent, EvalAgentRequest } from "./runner.js";
import {
  EvalScore,
  EvalScoreSchema,
  ModelConfig,
  ModelProduceResponseSchema,
  OutputFile,
  SkillResearchPatchSchema
} from "./schemas.js";

export interface FlueAutoresearchOptions extends Omit<OrchestrateOptions, "agent" | "researcher"> {
  session: FlueSession;
}

export type FlueWorkflowResult = {
  completedIterations: number;
  normalizedScore: number;
  bestSkillDir?: string;
  runLogPath?: string;
  cost: ModelRunCostSummary;
  events: string[];
};

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
    await persistTranscript(join(request.sandbox.outputDir, "producer-flue-transcript.json"), produceRequest, produced);

    return this.judge(request, produced.output_files);
  }

  async judge(request: EvalAgentRequest, outputFiles: OutputFile[]): Promise<EvalScore> {
    const judgeRequest = await buildJudgeModelRequest(request, outputFiles);
    request.costTracker?.assertCanStartModelCall();
    const { data: score } = await this.#session.task(judgeRequest.prompt, {
      result: EvalScoreSchema,
      agent: JUDGE_AGENT,
      model: toFlueModel(judgeRequest.model),
      cwd: judgeRequest.workspaceDir
    });
    recordFlueCall(request.costTracker, request.baseline ? "baseline_judge" : "iteration_judge", judgeRequest);
    const validated = parseModelJudgeResponse(JSON.stringify(score), request.evalCase, request.track);
    await persistTranscript(join(request.sandbox.outputDir, "judge-flue-transcript.json"), judgeRequest, validated);
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
    await persistResearchArtifact(
      request,
      modelRequest,
      patch,
      patch,
      ".autoresearch-flue-transcript.json",
      researchArtifactOperations
    );
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
