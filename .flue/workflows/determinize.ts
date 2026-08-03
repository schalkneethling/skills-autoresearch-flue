import type { FlueContext } from "@flue/runtime";
import { createAgent } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { resolve } from "node:path";
import { runDeterminizationReport } from "../../src/determinization/run.js";
import { FlueDeterminizationTransport } from "../../src/determinization/transport.js";
import { determinizerProfile } from "../profiles.js";

interface DeterminizePayload {
  projectRoot?: string;
  skillDir?: string;
  contextRoot?: string;
  catalogRoot?: string;
  outputRoot?: string;
  sessionId?: string;
  model?: string;
}

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
const ANTHROPIC_MODEL_PATTERN = /^anthropic\/[^/\s]+$/u;

function parseModelOverride(model: string | undefined): { provider: "anthropic"; name: string } | undefined {
  if (model === undefined) return undefined;
  if (!ANTHROPIC_MODEL_PATTERN.test(model)) {
    throw new Error("Determinization model must use the format anthropic/<non-empty-model>");
  }
  return { provider: "anthropic", name: model.slice("anthropic/".length) };
}

export async function run({ init, payload, env }: FlueContext<DeterminizePayload>) {
  const rawModelOverride = payload.model ?? env.FLUE_MODEL;
  const modelOverride = parseModelOverride(rawModelOverride);
  const agentModel = modelOverride ? `${modelOverride.provider}/${modelOverride.name}` : DEFAULT_MODEL;
  const agent = createAgent(() => ({ sandbox: local(), model: agentModel, subagents: [determinizerProfile] }));
  const harness = await init(agent);
  const session = await harness.session(payload.sessionId ?? "determinize-report");
  return runDeterminizationReport({
    projectRoot: resolve(payload.projectRoot ?? process.cwd()),
    transport: new FlueDeterminizationTransport(session),
    ...(modelOverride && { modelOverride }),
    ...(payload.skillDir && { skillDir: payload.skillDir }),
    ...(payload.contextRoot && { contextRoot: payload.contextRoot }),
    ...(payload.catalogRoot && { catalogRoot: payload.catalogRoot }),
    ...(payload.outputRoot && { outputRoot: payload.outputRoot })
  });
}
