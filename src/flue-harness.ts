import type { FlueSession } from "@flue/sdk/client";
import {
  applyOutputFiles,
  buildJudgeModelRequest,
  buildProduceModelRequest,
  buildResearchModelRequest,
  parseModelJudgeResponse
} from "./model-agent.js";
import { orchestrateBaseline, OrchestrateOptions, SkillResearcher } from "./orchestrator.js";
import { EvalAgent, EvalAgentRequest } from "./runner.js";
import {
  EvalScore,
  EvalScoreSchema,
  ModelProduceResponseSchema,
  SkillResearchPatchSchema,
  SkillResearchPatch,
  ModelProduceResponse
} from "./schemas.js";
import { applySkillResearchPatch, validateSkillResearchPatch } from "./model-agent.js";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FlueAutoresearchOptions extends Omit<OrchestrateOptions, "agent" | "researcher"> {
  session: FlueSession;
}

export class FlueEvalAgent implements EvalAgent {
  readonly #session: FlueSession;

  constructor(session: FlueSession) {
    this.#session = session;
  }

  async run(request: EvalAgentRequest): Promise<EvalScore> {
    const produceRequest = await buildProduceModelRequest(request);
    const produced = (await this.#session.prompt(produceRequest.prompt, {
      result: ModelProduceResponseSchema,
      model: toFlueModel(produceRequest.model)
    })) as ModelProduceResponse;
    await applyOutputFiles(request.sandbox.outputDir, produced.output_files);
    await writeTranscript(request.sandbox.outputDir, "producer-flue-transcript.json", {
      request: produceRequest,
      response: produced
    });

    const judgeRequest = await buildJudgeModelRequest(request, produced.output_files);
    const score = (await this.#session.prompt(judgeRequest.prompt, {
      result: EvalScoreSchema,
      role: request.modelRoles?.judge,
      model: toFlueModel(judgeRequest.model)
    })) as EvalScore;
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
    const patch = (await this.#session.prompt(modelRequest.prompt, {
      result: SkillResearchPatchSchema,
      model: toFlueModel(modelRequest.model)
    })) as SkillResearchPatch;
    validateSkillResearchPatch(request.candidateSkillDir, patch);
    await cp(request.previousSkillDir, request.candidateSkillDir, {
      recursive: true,
      errorOnExist: true,
      force: false
    });
    await mkdir(request.candidateSkillDir, { recursive: true });
    await applySkillResearchPatch(request.candidateSkillDir, patch);
    await writeFile(join(request.candidateSkillDir, "RESEARCH.md"), formatResearchSummary(patch), { flag: "wx" });
    await writeTranscript(request.candidateSkillDir, ".autoresearch-flue-transcript.json", {
      request: modelRequest,
      response: patch
    });
  }
}

function toFlueModel(model: { provider: string; name: string }): string {
  return `${model.provider}/${model.name}`;
}

export async function runFlueAutoresearch(options: FlueAutoresearchOptions) {
  return orchestrateBaseline({
    ...options,
    agent: new FlueEvalAgent(options.session),
    researcher: options.runResearch ? new FlueSkillResearcher(options.session) : undefined
  });
}

async function writeTranscript(dir: string, fileName: string, value: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function formatResearchSummary(patch: SkillResearchPatch): string {
  return [
    "# Research Summary",
    "",
    patch.summary,
    "",
    "## Changed Files",
    "",
    ...patch.changes.map((change) => `- ${change.path}`)
  ].join("\n");
}
