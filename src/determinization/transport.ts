import type { FlueSession } from "@flue/runtime";
import * as v from "valibot";
import type { ModelClient, ModelCompletion, ModelRequest } from "../model-agent.js";
import { modelCompletionText, modelCompletionUsage } from "../model-agent.js";
import type { ModelUsage } from "../cost.js";
import type { ModelConfig } from "../schemas.js";

export interface DeterminizationTransportRequest {
  system: string;
  prompt: string;
  model: ModelConfig;
  cwd?: string;
}

export interface DeterminizationTransportResult {
  response: unknown;
  transcript: { request: DeterminizationTransportRequest; response: unknown };
  usage?: ModelUsage;
  costUsd?: number;
}

export interface DeterminizationTransport {
  readonly name: string;
  readonly makesModelCall: boolean;
  analyze(request: DeterminizationTransportRequest): Promise<DeterminizationTransportResult>;
}

function parseJsonResponse(completion: ModelCompletion): unknown {
  const text = modelCompletionText(completion).trim();
  const unwrapped = text.startsWith("```") ? text.replace(/^```(?:json)?\s*/u, "").replace(/\s*```$/u, "") : text;
  try {
    return JSON.parse(unwrapped) as unknown;
  } catch (error) {
    throw new Error("Determinizer response was not valid JSON", { cause: error });
  }
}

export class DirectModelDeterminizationTransport implements DeterminizationTransport {
  readonly name = "direct-model";
  readonly makesModelCall = true;

  constructor(private readonly client: ModelClient) {}

  async analyze(request: DeterminizationTransportRequest): Promise<DeterminizationTransportResult> {
    const modelRequest: ModelRequest = {
      system: request.system,
      prompt: request.prompt,
      model: request.model,
      phase: "determinization analysis",
      ...(request.cwd && { workspaceDir: request.cwd })
    };
    const completion = await this.client.complete(modelRequest);
    const response = parseJsonResponse(completion);
    return {
      response,
      transcript: { request, response },
      usage: modelCompletionUsage(completion)
    };
  }
}

/**
 * FlueSession.task has no system-prompt option, so the workflow supplies the
 * determinizer system guidance through determinizerProfile.instructions.
 */
export class FlueDeterminizationTransport implements DeterminizationTransport {
  readonly name = "flue";
  readonly makesModelCall = true;

  constructor(private readonly session: FlueSession) {}

  /** Maps Flue's aggregate token usage and model-registry-derived cost into the transport-neutral result. */
  async analyze(request: DeterminizationTransportRequest): Promise<DeterminizationTransportResult> {
    const { data, usage } = await this.session.task(request.prompt, {
      result: v.unknown(),
      agent: "determinizer",
      model: `${request.model.provider}/${request.model.name}`,
      ...(request.cwd && { cwd: request.cwd })
    });
    return {
      response: data,
      transcript: { request, response: data },
      usage: {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheCreationInputTokens: usage.cacheWrite,
        cacheReadInputTokens: usage.cacheRead
      },
      costUsd: usage.cost.total
    };
  }
}

export class StaticDeterminizationTransport implements DeterminizationTransport {
  readonly name = "response-file";
  readonly makesModelCall = false;

  constructor(private readonly response: unknown) {}

  async analyze(request: DeterminizationTransportRequest): Promise<DeterminizationTransportResult> {
    return { response: this.response, transcript: { request, response: this.response } };
  }
}
