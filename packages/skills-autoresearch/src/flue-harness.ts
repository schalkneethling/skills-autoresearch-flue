import { join } from "node:path";
import { ModelCallRole, ModelRunCostSummary } from "./cost.js";
import type { FlueRoleDispatcher, FlueRoleResult } from "./flue-runtime.js";
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
import { EvalScore, ModelConfig, OutputFile } from "./schemas.js";

export interface FlueAutoresearchOptions extends Omit<OrchestrateOptions, "agent" | "researcher"> {
  dispatcher: FlueRoleDispatcher;
}

export type FlueWorkflowResult = {
  completedIterations: number;
  normalizedScore: number;
  bestSkillDir?: string;
  runLogPath?: string;
  cost: ModelRunCostSummary;
  events: string[];
};

export class FlueEvalAgent implements EvalAgent {
  readonly #dispatcher: FlueRoleDispatcher;

  constructor(dispatcher: FlueRoleDispatcher) {
    this.#dispatcher = dispatcher;
  }

  async run(request: EvalAgentRequest): Promise<EvalScore> {
    const produceRequest = await buildProduceModelRequest(request);
    request.costTracker?.assertCanStartModelCall();
    const producedResult = await this.#dispatcher.produce({
      prompt: produceRequest.prompt,
      model: toFlueModel(produceRequest.model)
    });
    const produced = producedResult.data;
    recordFlueCall(
      request.costTracker,
      request.baseline ? "baseline_producer" : "iteration_producer",
      produceRequest,
      producedResult
    );
    await applyOutputFiles(request.sandbox.outputDir, produced.output_files);
    await persistTranscript(join(request.sandbox.outputDir, "producer-flue-transcript.json"), produceRequest, produced);

    return this.judge(request, produced.output_files);
  }

  async judge(request: EvalAgentRequest, outputFiles: OutputFile[]): Promise<EvalScore> {
    const judgeRequest = await buildJudgeModelRequest(request, outputFiles);
    request.costTracker?.assertCanStartModelCall();
    const scoreResult = await this.#dispatcher.judge({
      prompt: judgeRequest.prompt,
      model: toFlueModel(judgeRequest.model)
    });
    const score = scoreResult.data;
    recordFlueCall(
      request.costTracker,
      request.baseline ? "baseline_judge" : "iteration_judge",
      judgeRequest,
      scoreResult
    );
    const validated = parseModelJudgeResponse(JSON.stringify(score), request.evalCase, request.track);
    await persistTranscript(join(request.sandbox.outputDir, "judge-flue-transcript.json"), judgeRequest, validated);
    return validated;
  }
}

export class FlueSkillResearcher implements SkillResearcher {
  readonly #dispatcher: FlueRoleDispatcher;

  constructor(dispatcher: FlueRoleDispatcher) {
    this.#dispatcher = dispatcher;
  }

  async improve(request: Parameters<SkillResearcher["improve"]>[0]): Promise<void> {
    const modelRequest = await buildResearchModelRequest(request);
    request.costTracker?.assertCanStartModelCall();
    const patchResult = await this.#dispatcher.research({
      prompt: modelRequest.prompt,
      model: toFlueModel(modelRequest.model)
    });
    const patch = patchResult.data;
    recordFlueCall(request.costTracker, "researcher", modelRequest, patchResult);
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
  request: { phase?: string; model: ModelConfig },
  result: Pick<FlueRoleResult<unknown>, "usage" | "costUsd">
): void {
  tracker?.recordModelCall({
    role,
    phase: request.phase,
    model: request.model,
    usage: result.usage,
    costUsd: result.costUsd
  });
}

function toFlueModel(model: { provider: string; name: string }): string {
  return `${model.provider}/${model.name}`;
}

export async function runFlueAutoresearch(options: FlueAutoresearchOptions) {
  return orchestrateBaseline({
    ...options,
    modelBacked: true,
    agent: new FlueEvalAgent(options.dispatcher),
    researcher: options.runResearch ? new FlueSkillResearcher(options.dispatcher) : undefined
  });
}
