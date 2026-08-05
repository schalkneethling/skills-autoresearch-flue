"use agent";

import { useDataWriter, useModel, useTool } from "@flue/runtime";
import * as v from "valibot";

export const producerModel = "faux-role-boundary/producer-exact";
export const judgeModel = "faux-role-boundary/judge-exact";

export const producerResultSchema = v.strictObject({
  draft: v.pipe(v.string(), v.minLength(1))
});

export const judgeResultSchema = v.strictObject({
  rationale: v.pipe(v.string(), v.minLength(1)),
  score: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(100))
});

export function Producer() {
  useModel(producerModel);
  const writeResult = useDataWriter("producer-result", {
    schema: producerResultSchema
  });

  useTool({
    name: "submit_producer_output",
    description: "Submit the produced draft and end the turn.",
    input: producerResultSchema,
    output: producerResultSchema,
    run({ data }) {
      writeResult(data);
      return { output: data, terminate: true };
    }
  });

  return [
    "ROLE_BOUNDARY_PRODUCER_ONLY",
    "Produce the requested artifact.",
    "Never judge, score, or critique the artifact.",
    "You have exactly one submission capability: submit_producer_output."
  ].join("\n");
}
Producer.agentName = "producer-role";

export function Judge() {
  useModel(judgeModel);
  const writeResult = useDataWriter("judge-result", {
    schema: judgeResultSchema
  });

  useTool({
    name: "submit_judge_result",
    description: "Submit the judgment and end the turn.",
    input: judgeResultSchema,
    output: judgeResultSchema,
    run({ data }) {
      writeResult(data);
      return { output: data, terminate: true };
    }
  });

  return [
    "ROLE_BOUNDARY_JUDGE_ONLY",
    "Judge the supplied artifact against the supplied criterion.",
    "Never create or rewrite the artifact.",
    "You have exactly one submission capability: submit_judge_result."
  ].join("\n");
}
Judge.agentName = "judge-role";
