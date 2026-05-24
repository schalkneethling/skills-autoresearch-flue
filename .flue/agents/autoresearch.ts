import type { FlueContext } from "@flue/runtime/client";
import { local } from "@flue/runtime/node";
import { runFlueAutoresearch } from "../../src/flue-harness.js";

export const triggers = {};

interface AutoresearchPayload {
  projectRoot?: string;
  withBaseline?: boolean;
  runResearch?: boolean;
  forceResearch?: boolean;
  seedSkillDir?: string;
  sessionId?: string;
  model?: string;
}

export default async function ({ init, payload, env }: FlueContext<AutoresearchPayload>) {
  const model = payload.model ?? env.FLUE_MODEL ?? "anthropic/claude-sonnet-4-6";
  const agent = await init({
    sandbox: local(),
    model
  });
  const session = await agent.session(payload.sessionId ?? "autoresearch");
  const result = await runFlueAutoresearch({
    session,
    projectRoot: payload.projectRoot ?? process.cwd(),
    withBaseline: payload.withBaseline,
    runResearch: payload.runResearch,
    forceResearch: payload.forceResearch,
    seedSkillDir: payload.seedSkillDir
  });

  return {
    completedIterations: result.completedIterations,
    normalizedScore: result.aggregate.overall.normalizedScore,
    bestSkillDir: result.bestIteration?.skillDir,
    events: result.events.map((event) => event.type)
  };
}
