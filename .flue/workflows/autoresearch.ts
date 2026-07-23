import type { FlueContext } from "@flue/runtime";
import { createAgent } from "@flue/runtime";
import { local } from "@flue/runtime/node";
import { runFlueAutoresearch, type FlueWorkflowResult } from "../../src/flue-harness.js";
import { formatEvent } from "../../src/cli.js";
import { autoresearchProfiles } from "../profiles.js";

interface AutoresearchPayload {
  projectRoot?: string;
  withBaseline?: boolean;
  runResearch?: boolean;
  forceResearch?: boolean;
  resume?: boolean;
  withCleanup?: boolean;
  seedSkillDir?: string;
  guidanceSkillDir?: string;
  budgetUsd?: number;
  sessionId?: string;
  model?: string;
  verbose?: boolean;
  writeRunLog?: boolean;
  runLogPath?: string;
}

export async function run({ init, payload, env, log }: FlueContext<AutoresearchPayload>): Promise<FlueWorkflowResult> {
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
    resume: payload.resume,
    withCleanup: payload.withCleanup,
    seedSkillDir: payload.seedSkillDir,
    guidanceSkillDir: payload.guidanceSkillDir,
    budgetUsd: payload.budgetUsd,
    onEvent(event) {
      const formatted = formatEvent(event);
      if (formatted.level === "debug" && !payload.verbose) {
        return;
      }
      if (formatted.level === "warn") {
        log.warn(formatted.message);
      } else if (formatted.level === "error") {
        log.error(formatted.message);
      } else {
        log.info(formatted.message);
      }
    }
  });

  return {
    completedIterations: result.completedIterations,
    normalizedScore: result.aggregate.overall.normalizedScore,
    bestSkillDir: result.bestIteration?.skillDir,
    runLogPath: payload.runLogPath,
    cost: result.cost,
    events: result.events.map((event) => event.type)
  };
}
