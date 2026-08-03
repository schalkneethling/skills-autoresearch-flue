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

export async function run({ init, payload, env }: FlueContext<DeterminizePayload>) {
  const model = payload.model ?? env.FLUE_MODEL ?? "anthropic/claude-sonnet-4-6";
  const agent = createAgent(() => ({ sandbox: local(), model, subagents: [determinizerProfile] }));
  const harness = await init(agent);
  const session = await harness.session(payload.sessionId ?? "determinize-report");
  return runDeterminizationReport({
    projectRoot: resolve(payload.projectRoot ?? process.cwd()),
    transport: new FlueDeterminizationTransport(session),
    ...(payload.skillDir && { skillDir: payload.skillDir }),
    ...(payload.contextRoot && { contextRoot: payload.contextRoot }),
    ...(payload.catalogRoot && { catalogRoot: payload.catalogRoot }),
    ...(payload.outputRoot && { outputRoot: payload.outputRoot })
  });
}
