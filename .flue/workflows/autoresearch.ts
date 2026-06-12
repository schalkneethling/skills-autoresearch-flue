import type { FlueContext } from "@flue/runtime";
import { createAgent } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { runFlueAutoresearch } from "../../src/flue-harness.js";
import { autoresearchProfiles } from "../profiles.js";

interface AutoresearchPayload {
  projectRoot?: string;
  withBaseline?: boolean;
  runResearch?: boolean;
  forceResearch?: boolean;
  seedSkillDir?: string;
  guidanceSkillDir?: string;
  budgetUsd?: number;
  sessionId?: string;
  model?: string;
}

export async function run({ init, payload, env }: FlueContext<AutoresearchPayload>) {
  const model = payload.model ?? env.FLUE_MODEL ?? "anthropic/claude-sonnet-4-6";
  const autoresearch = createAgent(() => ({
    sandbox: local(),
    model,
    subagents: autoresearchProfiles
  }));
  const harness = await init(autoresearch);
  const session = await harness.session(payload.sessionId ?? "autoresearch");
  const result = await runFlueAutoresearch({
    session,
    projectRoot: payload.projectRoot ?? process.cwd(),
    withBaseline: payload.withBaseline,
    runResearch: payload.runResearch,
    forceResearch: payload.forceResearch,
    seedSkillDir: payload.seedSkillDir,
    guidanceSkillDir: payload.guidanceSkillDir,
    budgetUsd: payload.budgetUsd
  });

  return {
    completedIterations: result.completedIterations,
    normalizedScore: result.aggregate.overall.normalizedScore,
    bestSkillDir: result.bestIteration?.skillDir,
    cost: result.cost,
    events: result.events.map((event) => event.type)
  };
}
