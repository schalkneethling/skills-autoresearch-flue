import type { ModelClient, ModelCompletion, ModelRequest } from "../model-agent.js";
import { modelCompletionText, modelCompletionUsage } from "../model-agent.js";
import type { ModelUsage } from "../cost.js";
import type { FlueRoleDispatcher } from "../flue-runtime.js";
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

  constructor(
    private readonly client: ModelClient,
    private readonly timeoutMs = 60_000
  ) {}

  async analyze(request: DeterminizationTransportRequest): Promise<DeterminizationTransportResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Determinization model request timed out")), this.timeoutMs);
    const modelRequest: ModelRequest = {
      system: request.system,
      prompt: request.prompt,
      model: request.model,
      phase: "determinization analysis",
      ...(request.cwd && { workspaceDir: request.cwd }),
      signal: controller.signal
    };
    let completion: ModelCompletion;
    try {
      completion = await Promise.race([
        this.client.complete(modelRequest),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
        )
      ]);
    } finally {
      clearTimeout(timeout);
    }
    const response = parseJsonResponse(completion);
    return {
      response,
      transcript: { request, response },
      usage: modelCompletionUsage(completion)
    };
  }
}

/**
 * Flue 2 dispatch has no system-prompt option, so the top-level Determinizer
 * agent declares the system guidance. Aggregate usage and provider-reported
 * cost come from useResponseFinish metadata through the dispatcher.
 */
export class FlueDeterminizationTransport implements DeterminizationTransport {
  readonly name = "flue";
  readonly makesModelCall = true;

  constructor(private readonly dispatcher: FlueRoleDispatcher) {}

  async analyze(request: DeterminizationTransportRequest): Promise<DeterminizationTransportResult> {
    const result = await this.dispatcher.determinize({
      prompt: request.prompt,
      model: `${request.model.provider}/${request.model.name}`
    });
    return {
      response: result.data,
      transcript: { request, response: result.data },
      usage: result.usage,
      costUsd: result.costUsd
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
