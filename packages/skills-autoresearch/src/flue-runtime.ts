import { randomUUID } from "node:crypto";

import { init, type Agent, type AgentReply } from "@flue/runtime";
import { start, type Flue, type StartOptions } from "@flue/runtime/node";
import * as v from "valibot";

import type { ModelUsage } from "./cost.js";
import {
  Determinizer,
  DETERMINIZER_DATA_CHANNEL,
  FlueRoleInitialDataSchema,
  Judge,
  JUDGE_DATA_CHANNEL,
  Producer,
  PRODUCER_DATA_CHANNEL,
  RawDeterminizationAnalysisSchema,
  Researcher,
  RESEARCHER_DATA_CHANNEL
} from "./flue-agents.js";
import {
  EvalScoreSchema,
  ModelProduceResponseSchema,
  parseWithSchema,
  SkillResearchPatchSchema,
  type EvalScore,
  type ModelProduceResponse,
  type SkillResearchPatch
} from "./schemas.js";
import type { RawDeterminizationAnalysis } from "./flue-agents.js";

const NonNegativeNumberSchema = v.pipe(v.number(), v.minValue(0));
const FlueUsageSchema = v.strictObject({
  input: NonNegativeNumberSchema,
  output: NonNegativeNumberSchema,
  cacheRead: NonNegativeNumberSchema,
  cacheWrite: NonNegativeNumberSchema,
  totalTokens: NonNegativeNumberSchema,
  cost: v.strictObject({
    input: NonNegativeNumberSchema,
    output: NonNegativeNumberSchema,
    cacheRead: NonNegativeNumberSchema,
    cacheWrite: NonNegativeNumberSchema,
    total: NonNegativeNumberSchema
  })
});
const FlueReplyMetadataSchema = v.strictObject({ usage: FlueUsageSchema });
const FlueRoleRequestSchema = v.strictObject({
  prompt: v.pipe(v.string(), v.minLength(1)),
  model: FlueRoleInitialDataSchema.entries.model
});

export interface FlueRoleRequest {
  prompt: string;
  model: string;
}

export interface FlueRoleResult<T> {
  data: T;
  text: string;
  usage: ModelUsage;
  costUsd: number;
  instanceId: string;
  submissionId: string;
}

export interface FlueRoleDispatcher {
  produce(request: FlueRoleRequest): Promise<FlueRoleResult<ModelProduceResponse>>;
  judge(request: FlueRoleRequest): Promise<FlueRoleResult<EvalScore>>;
  research(request: FlueRoleRequest): Promise<FlueRoleResult<SkillResearchPatch>>;
  determinize(request: FlueRoleRequest): Promise<FlueRoleResult<RawDeterminizationAnalysis>>;
}

export interface FlueRoleRuntime extends FlueRoleDispatcher {
  stop(): Promise<void>;
}

export interface StartFlueRoleRuntimeOptions {
  db?: StartOptions["db"];
  env?: StartOptions["env"];
  providers?: StartOptions["providers"];
  instanceIdPrefix?: string;
}

let activeRuntime: DefaultFlueRoleRuntime | undefined;
let runtimeStarting = false;

class DefaultFlueRoleRuntime implements FlueRoleRuntime {
  readonly #flue: Flue;
  readonly #instancePrefix: string;
  #callSequence = 0;
  #stopped = false;

  constructor(flue: Flue, instancePrefix: string) {
    this.#flue = flue;
    this.#instancePrefix = instancePrefix;
  }

  produce(request: FlueRoleRequest): Promise<FlueRoleResult<ModelProduceResponse>> {
    return this.#dispatch(Producer, "producer", PRODUCER_DATA_CHANNEL, ModelProduceResponseSchema, request);
  }

  judge(request: FlueRoleRequest): Promise<FlueRoleResult<EvalScore>> {
    return this.#dispatch(Judge, "judge", JUDGE_DATA_CHANNEL, EvalScoreSchema, request);
  }

  research(request: FlueRoleRequest): Promise<FlueRoleResult<SkillResearchPatch>> {
    return this.#dispatch(Researcher, "researcher", RESEARCHER_DATA_CHANNEL, SkillResearchPatchSchema, request);
  }

  determinize(request: FlueRoleRequest): Promise<FlueRoleResult<RawDeterminizationAnalysis>> {
    return this.#dispatch(
      Determinizer,
      "determinizer",
      DETERMINIZER_DATA_CHANNEL,
      RawDeterminizationAnalysisSchema,
      request
    );
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    try {
      await this.#flue.stop();
    } finally {
      if (activeRuntime === this) activeRuntime = undefined;
    }
  }

  async #dispatch<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
    agent: Agent,
    role: string,
    channel: string,
    schema: TSchema,
    request: FlueRoleRequest
  ): Promise<FlueRoleResult<v.InferOutput<TSchema>>> {
    if (this.#stopped) throw new Error("The Flue role runtime has already stopped");
    const validatedRequest = parseWithSchema(FlueRoleRequestSchema, request, "Flue role request");
    const instanceId = `${this.#instancePrefix}-${role}-${++this.#callSequence}-${randomUUID()}`;
    const handle = init(agent, { id: instanceId, uid: null });
    const receipt = await handle.dispatch({
      message: validatedRequest.prompt,
      initialData: { model: validatedRequest.model }
    });
    const reply = await handle.read(receipt);
    const data = parseRoleReply(reply, channel, schema);
    const metadata = parseWithSchema(FlueReplyMetadataSchema, reply.metadata, "Flue role reply metadata");

    return {
      data,
      text: reply.text,
      usage: {
        inputTokens: metadata.usage.input,
        outputTokens: metadata.usage.output,
        cacheCreationInputTokens: metadata.usage.cacheWrite,
        cacheReadInputTokens: metadata.usage.cacheRead
      },
      costUsd: metadata.usage.cost.total,
      instanceId,
      submissionId: reply.submissionId
    };
  }
}

export async function startFlueRoleRuntime(options: StartFlueRoleRuntimeOptions = {}): Promise<FlueRoleRuntime> {
  if (activeRuntime || runtimeStarting) throw new Error("A Flue role runtime is already active in this process");
  const requestedPrefix = options.instanceIdPrefix?.trim();
  if (requestedPrefix !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(requestedPrefix)) {
    throw new Error("Flue role runtime instanceIdPrefix must use only letters, numbers, dots, underscores, or hyphens");
  }
  runtimeStarting = true;
  try {
    const flue = await start({
      agents: [Producer, Judge, Researcher, Determinizer],
      ...(options.db !== undefined && { db: options.db }),
      ...(options.env !== undefined && { env: options.env }),
      ...(options.providers !== undefined && { providers: options.providers })
    });
    const runtime = new DefaultFlueRoleRuntime(flue, `${requestedPrefix ?? "flue"}-${randomUUID()}`);
    activeRuntime = runtime;
    return runtime;
  } finally {
    runtimeStarting = false;
  }
}

export async function withFlueRoleRuntime<T>(
  run: (runtime: FlueRoleRuntime) => Promise<T>,
  options: StartFlueRoleRuntimeOptions = {}
): Promise<T> {
  const runtime = await startFlueRoleRuntime(options);
  try {
    return await run(runtime);
  } finally {
    await runtime.stop();
  }
}

function parseRoleReply<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  reply: AgentReply,
  channel: string,
  schema: TSchema
): v.InferOutput<TSchema> {
  const unexpectedChannels = Object.keys(reply.data).filter((name) => name !== channel);
  if (unexpectedChannels.length > 0) {
    throw new Error(`Flue role reply contained unexpected data channels: ${unexpectedChannels.sort().join(", ")}`);
  }
  const values = reply.data[channel];
  if (!values || values.length !== 1) {
    throw new Error(`Flue role reply must contain exactly one ${channel} value`);
  }
  return parseWithSchema(schema, values[0], `${channel} value`);
}
