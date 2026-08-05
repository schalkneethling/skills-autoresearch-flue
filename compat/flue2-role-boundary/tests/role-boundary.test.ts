import { fauxAssistantMessage, fauxProvider, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { init } from "@flue/runtime";
import { start } from "@flue/runtime/node";
import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { Judge, Producer, judgeModel, producerModel } from "../src/roles.js";

const producerRequest = "Produce the isolated compatibility draft.";
const judgeRequest = "Judge only: candidate draft versus criterion.";

async function fixtureInventory(): Promise<string[]> {
  const entries = await readdir(new URL("..", import.meta.url), {
    recursive: true
  });

  return entries.filter((entry) => !entry.startsWith("node_modules/")).sort((left, right) => left.localeCompare(right));
}

function toolNames(context: Context): string[] {
  return (context.tools ?? []).map((tool) => tool.name).sort((left, right) => left.localeCompare(right));
}

describe("Flue 2 role boundary compatibility", () => {
  it("keeps producer and judge identity, context, tools, output, and model calls isolated", async () => {
    const inventoryBefore = await fixtureInventory();
    const faux = fauxProvider({
      provider: "faux-role-boundary",
      models: [
        { id: "producer-exact", reasoning: false },
        { id: "judge-exact", reasoning: false }
      ]
    });
    const observedContexts: Context[] = [];
    const observedModels: string[] = [];

    faux.setResponses([
      (context, _options, _state, model) => {
        observedContexts.push(context);
        observedModels.push(`${model.provider}/${model.id}`);
        return fauxAssistantMessage(
          fauxToolCall("submit_producer_output", {
            draft: "A deterministic producer artifact."
          }),
          { stopReason: "toolUse" }
        );
      },
      (context, _options, _state, model) => {
        observedContexts.push(context);
        observedModels.push(`${model.provider}/${model.id}`);
        return fauxAssistantMessage(
          fauxToolCall("submit_judge_result", {
            rationale: "The first call is deliberately malformed.",
            score: "not-a-number"
          }),
          { stopReason: "toolUse" }
        );
      },
      (context, _options, _state, model) => {
        observedContexts.push(context);
        observedModels.push(`${model.provider}/${model.id}`);
        return fauxAssistantMessage(
          fauxToolCall("submit_judge_result", {
            rationale: "The candidate satisfies the compatibility criterion.",
            score: 92
          }),
          { stopReason: "toolUse" }
        );
      }
    ]);

    const runtime = await start({
      agents: [Producer, Judge],
      providers: [faux.provider],
      env: {}
    });

    try {
      const producer = init(Producer, { id: "compat-producer" });
      const producerReceipt = await producer.dispatch(producerRequest);
      const producerReply = await producer.read(producerReceipt);

      const judge = init(Judge, { id: "compat-judge" });
      const judgeReceipt = await judge.dispatch(judgeRequest);
      const judgeReply = await judge.read(judgeReceipt);

      expect(producerReply.data).toEqual({
        "producer-result": [{ draft: "A deterministic producer artifact." }]
      });
      expect(producerReply.data).not.toHaveProperty("judge-result");
      expect(judgeReply.data).toEqual({
        "judge-result": [
          {
            rationale: "The candidate satisfies the compatibility criterion.",
            score: 92
          }
        ]
      });
      expect(judgeReply.data).not.toHaveProperty("producer-result");

      expect(faux.state.callCount).toBe(3);
      expect(faux.getPendingResponseCount()).toBe(0);
      expect(observedModels).toEqual([producerModel, judgeModel, judgeModel]);

      const [producerContext, firstJudgeContext, retryJudgeContext] = observedContexts;
      expect(producerContext?.systemPrompt).toContain("ROLE_BOUNDARY_PRODUCER_ONLY");
      expect(producerContext?.systemPrompt).not.toContain("ROLE_BOUNDARY_JUDGE_ONLY");
      expect(JSON.stringify(producerContext?.messages)).toContain(producerRequest);
      expect(JSON.stringify(producerContext?.messages)).not.toContain(judgeRequest);
      expect(toolNames(producerContext!)).toEqual(["submit_producer_output", "task"]);

      for (const context of [firstJudgeContext, retryJudgeContext]) {
        expect(context?.systemPrompt).toContain("ROLE_BOUNDARY_JUDGE_ONLY");
        expect(context?.systemPrompt).not.toContain("ROLE_BOUNDARY_PRODUCER_ONLY");
        expect(JSON.stringify(context?.messages)).toContain(judgeRequest);
        expect(JSON.stringify(context?.messages)).not.toContain(producerRequest);
        expect(toolNames(context!)).toEqual(["submit_judge_result", "task"]);
      }

      const retryMessages = JSON.stringify(retryJudgeContext?.messages);
      expect(retryMessages).toContain("not-a-number");
      expect(retryMessages).toMatch(/validation|number/i);
    } finally {
      await runtime.stop();
    }

    const restartedRuntime = await start({
      agents: [Producer, Judge],
      providers: [faux.provider],
      env: {}
    });
    await restartedRuntime.stop();

    expect(await fixtureInventory()).toEqual(inventoryBefore);
  });
});
