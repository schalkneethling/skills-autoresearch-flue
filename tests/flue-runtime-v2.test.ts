import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type Context } from "@earendil-works/pi-ai";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";

import { RawDeterminizationAnalysisSchema } from "../src/flue-agents.js";
import { startFlueRoleRuntime, withFlueRoleRuntime } from "../src/flue-runtime.js";

const providerName = "faux-production-runtime";
const models = {
  producer: `${providerName}/producer`,
  producerAlternate: `${providerName}/producer-alternate`,
  judge: `${providerName}/judge`,
  researcher: `${providerName}/researcher`,
  determinizer: `${providerName}/determinizer`
};

const producerOutput = {
  output_files: [{ path: "release.md", contents: "A deterministic producer artifact." }]
};
const judgeOutput = {
  eval_id: "release-note",
  eval_type: "writing",
  track_id: "default",
  total_score: 9,
  max_score: 10,
  dimensions: [{ id: "clarity", score: 9, max_score: 10, rationale: "Clear and bounded." }],
  summary: "The artifact satisfies the supplied criterion."
};
const researchOutput = {
  summary: "Tighten the release-note instruction.",
  guidance: [],
  resource_decisions: [],
  changes: [{ path: "SKILL.md", contents: "Prefer concrete, concise release notes." }]
};
const determinizationOutput = {
  schema_version: "1.0.0" as const,
  opportunities: [
    {
      source_refs: [{ path: "skill/SKILL.md", locator: "Guidance", evidence_kind: "skill" as const }],
      normalized_requirement: "Keep the output concise.",
      origin: "skill_guidance" as const,
      classification: "partially_deterministic" as const,
      current_automation_potential: "medium" as const,
      remaining_human_judgment: "Editors must assess whether necessary detail was retained.",
      recommendations: [],
      confidence: "high" as const,
      expected_improvement: "Metrics can flag likely wordiness for review.",
      supporting_evidence: ["The skill explicitly requests concise output."],
      limitations: ["A length metric cannot determine whether detail is necessary."]
    }
  ]
};

function toolNames(context: Context): string[] {
  return (context.tools ?? []).map(({ name }) => name).sort((left, right) => left.localeCompare(right));
}

describe("Flue 2 production role runtime", () => {
  it("isolates all roles and models, enforces structured completion, maps usage, and restarts cleanly", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flue-role-runtime-"));
    const sentinelPath = join(workspace, "sentinel.txt");
    await writeFile(sentinelPath, "unchanged\n");
    const inventoryBefore = await readdir(workspace);

    const faux = fauxProvider({
      provider: providerName,
      models: [
        { id: "producer", reasoning: false, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } },
        {
          id: "producer-alternate",
          reasoning: false,
          cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 }
        },
        { id: "judge", reasoning: false, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } },
        { id: "researcher", reasoning: false, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } },
        { id: "determinizer", reasoning: false, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } }
      ]
    });
    const observedContexts: Context[] = [];
    const observedModels: string[] = [];
    faux.setResponses([
      (context, _options, _state, model) => {
        observedContexts.push(context);
        observedModels.push(`${model.provider}/${model.id}`);
        return fauxAssistantMessage(fauxToolCall("submit_producer_output", producerOutput), {
          stopReason: "toolUse"
        });
      },
      (context, _options, _state, model) => {
        observedContexts.push(context);
        observedModels.push(`${model.provider}/${model.id}`);
        return fauxAssistantMessage(fauxToolCall("submit_judge_result", { ...judgeOutput, total_score: "invalid" }), {
          stopReason: "toolUse"
        });
      },
      (context, _options, _state, model) => {
        observedContexts.push(context);
        observedModels.push(`${model.provider}/${model.id}`);
        return fauxAssistantMessage(fauxToolCall("submit_judge_result", judgeOutput), { stopReason: "toolUse" });
      },
      (context, _options, _state, model) => {
        observedContexts.push(context);
        observedModels.push(`${model.provider}/${model.id}`);
        return fauxAssistantMessage(fauxText("I forgot to submit the patch."));
      },
      (context, _options, _state, model) => {
        observedContexts.push(context);
        observedModels.push(`${model.provider}/${model.id}`);
        return fauxAssistantMessage(fauxToolCall("submit_research_patch", researchOutput), {
          stopReason: "toolUse"
        });
      },
      (context, _options, _state, model) => {
        observedContexts.push(context);
        observedModels.push(`${model.provider}/${model.id}`);
        return fauxAssistantMessage(fauxToolCall("submit_determinization_analysis", determinizationOutput), {
          stopReason: "toolUse"
        });
      },
      (context, _options, _state, model) => {
        observedContexts.push(context);
        observedModels.push(`${model.provider}/${model.id}`);
        return fauxAssistantMessage(fauxToolCall("submit_producer_output", producerOutput), {
          stopReason: "toolUse"
        });
      }
    ]);

    const runtime = await startFlueRoleRuntime({ providers: [faux.provider], env: {}, instanceIdPrefix: "test" });
    try {
      for (const malformedModel of ["missing-provider-separator", "anthropic/claude/extra", "anthropic//"]) {
        await expect(
          runtime.produce({ prompt: "This must fail before a model call.", model: malformedModel })
        ).rejects.toThrow(/provider\/model/u);
      }
      expect(faux.state.callCount).toBe(0);

      await expect(startFlueRoleRuntime({ providers: [faux.provider], env: {} })).rejects.toThrow(/already active/u);

      const producer = await runtime.produce({
        prompt: `Produce the isolated artifact. Do not access ${workspace}.`,
        model: models.producer
      });
      const judge = await runtime.judge({ prompt: "Judge only against the isolated criterion.", model: models.judge });
      const researcher = await runtime.research({
        prompt: "Improve only the supplied skill contract.",
        model: models.researcher
      });
      const determinizer = await runtime.determinize({
        prompt: `Analyze only; do not modify ${workspace}.`,
        model: models.determinizer
      });
      const alternateProducer = await runtime.produce({
        prompt: "Produce a second artifact in a fresh role instance.",
        model: models.producerAlternate
      });

      expect(producer.data).toEqual(producerOutput);
      expect(judge.data).toEqual(judgeOutput);
      expect(researcher.data).toEqual(researchOutput);
      expect(determinizer.data).toEqual(determinizationOutput);
      expect(alternateProducer.data).toEqual(producerOutput);
      expect(
        new Set([
          producer.instanceId,
          judge.instanceId,
          researcher.instanceId,
          determinizer.instanceId,
          alternateProducer.instanceId
        ]).size
      ).toBe(5);

      for (const result of [producer, judge, researcher, determinizer, alternateProducer]) {
        expect(result.usage.inputTokens).toBeGreaterThan(0);
        expect(result.usage.outputTokens).toBeGreaterThan(0);
        expect(result.costUsd).toBe(0);
        expect(result.submissionId).not.toHaveLength(0);
      }

      expect(observedModels).toEqual([
        models.producer,
        models.judge,
        models.judge,
        models.researcher,
        models.researcher,
        models.determinizer,
        models.producerAlternate
      ]);
      expect(faux.getPendingResponseCount()).toBe(0);

      const [
        producerContext,
        firstJudgeContext,
        retryJudgeContext,
        firstResearchContext,
        retryResearchContext,
        determinizerContext,
        alternateProducerContext
      ] = observedContexts;
      expect(producerContext?.systemPrompt).toContain("AUTORESEARCH_PRODUCER_ONLY");
      expect(producerContext?.systemPrompt).toContain("Follow the supplied skill closely");
      expect(producerContext?.systemPrompt).toContain("concrete output files only");
      expect(producerContext?.systemPrompt).toContain("Never self-score");
      expect(toolNames(producerContext!)).toEqual(["submit_producer_output", "task"]);
      expect(alternateProducerContext?.systemPrompt).toContain("AUTORESEARCH_PRODUCER_ONLY");
      expect(JSON.stringify(alternateProducerContext?.messages)).not.toContain("Produce the isolated artifact");

      for (const context of [firstJudgeContext, retryJudgeContext]) {
        expect(context?.systemPrompt).toContain("AUTORESEARCH_JUDGE_ONLY");
        expect(context?.systemPrompt).not.toContain("AUTORESEARCH_PRODUCER_ONLY");
        expect(context?.systemPrompt).toContain("independent evaluator");
        expect(context?.systemPrompt).toContain("score only the supplied producer outputs");
        expect(context?.systemPrompt).toContain("Do not credit a requirement merely because");
        expect(context?.systemPrompt).toContain("Give specific rationales");
        expect(context?.systemPrompt).toContain(
          "omissions, invented facts, regressions, unsafe assumptions, and unsupported claims"
        );
        expect(context?.systemPrompt).toContain("Do not create, rewrite, or improve");
        expect(JSON.stringify(context?.messages)).not.toContain("A deterministic producer artifact.");
        expect(toolNames(context!)).toEqual(["submit_judge_result", "task"]);
      }
      expect(JSON.stringify(retryJudgeContext?.messages)).toMatch(/validation|number/iu);

      for (const context of [firstResearchContext, retryResearchContext]) {
        expect(context?.systemPrompt).toContain("AUTORESEARCH_RESEARCHER_ONLY");
        expect(context?.systemPrompt).toContain("smallest effective change");
        expect(context?.systemPrompt).toContain("Preserve the skill's intended scope");
        expect(context?.systemPrompt).toContain("avoid overfitting to a single fixture");
        expect(context?.systemPrompt).toContain("auditable skill-file patch");
        expect(context?.systemPrompt).toContain("application remains owned by the harness");
        expect(toolNames(context!)).toEqual(["submit_research_patch", "task"]);
      }
      expect(JSON.stringify(retryResearchContext?.messages)).toContain("structured-submission-required");

      expect(determinizerContext?.systemPrompt).toContain("AUTORESEARCH_DETERMINIZER_ONLY");
      expect(determinizerContext?.systemPrompt).toContain("Remain read-only");
      expect(toolNames(determinizerContext!)).toEqual(["submit_determinization_analysis", "task"]);

      expect(await readdir(workspace)).toEqual(inventoryBefore);
      expect(await readFile(sentinelPath, "utf8")).toBe("unchanged\n");
    } finally {
      await runtime.stop();
      await runtime.stop();
      await rm(workspace, { recursive: true });
    }

    await expect(runtime.produce({ prompt: "Cannot run after stop.", model: models.producer })).rejects.toThrow(
      /already stopped/u
    );

    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("submit_producer_output", producerOutput), { stopReason: "toolUse" })
    ]);
    const restarted = await startFlueRoleRuntime({ providers: [faux.provider], env: {} });
    try {
      const result = await restarted.produce({ prompt: "Run after a clean restart.", model: models.producer });
      expect(result.data).toEqual(producerOutput);
    } finally {
      await restarted.stop();
    }
  });

  it("rejects generated fields and malformed canonical inputs at the raw determinizer boundary", () => {
    const generatedField = v.safeParse(RawDeterminizationAnalysisSchema, {
      ...determinizationOutput,
      opportunities: [{ ...determinizationOutput.opportunities[0], id: "opp_generated" }]
    });
    const absoluteSourcePath = v.safeParse(RawDeterminizationAnalysisSchema, {
      ...determinizationOutput,
      opportunities: [
        {
          ...determinizationOutput.opportunities[0],
          source_refs: [{ path: "/tmp/SKILL.md", evidence_kind: "skill" }]
        }
      ]
    });
    const recommendation = {
      relationship: "configurable",
      asset_kind: "script",
      catalog_asset_id: "asset_existing",
      proposed_name: "Existing asset",
      contribution: "Contributes a deterministic check.",
      confidence: "medium",
      expected_improvement: "Flags likely violations.",
      supporting_evidence: ["A bounded check is available."],
      limitations: ["Editorial judgment remains."],
      insufficiency_justification: undefined
    };
    const invalidAlternativeCardinality = v.safeParse(RawDeterminizationAnalysisSchema, {
      ...determinizationOutput,
      opportunities: [
        {
          ...determinizationOutput.opportunities[0],
          recommendations: [
            {
              ...recommendation,
              alternative_assessments: [
                {
                  relationship: "existing",
                  catalog_asset_ids: [],
                  conclusion: "insufficient",
                  rationale: "No existing asset is sufficient."
                }
              ]
            }
          ]
        }
      ]
    });
    const duplicateAlternativeIds = v.safeParse(RawDeterminizationAnalysisSchema, {
      ...determinizationOutput,
      opportunities: [
        {
          ...determinizationOutput.opportunities[0],
          recommendations: [
            {
              ...recommendation,
              alternative_assessments: [
                {
                  relationship: "existing",
                  catalog_asset_ids: ["asset_existing", "asset_existing"],
                  conclusion: "insufficient",
                  rationale: "The same asset must not be cited twice."
                }
              ]
            }
          ]
        }
      ]
    });

    expect(generatedField.success).toBe(false);
    expect(absoluteSourcePath.success).toBe(false);
    expect(invalidAlternativeCardinality.success).toBe(false);
    expect(duplicateAlternativeIds.success).toBe(false);
  });

  it("releases the singleton when a lifecycle callback throws", async () => {
    const faux = fauxProvider({ provider: "faux-lifecycle-cleanup" });

    await expect(
      withFlueRoleRuntime(
        async () => {
          throw new Error("Deliberate lifecycle failure");
        },
        { providers: [faux.provider], env: {} }
      )
    ).rejects.toThrow("Deliberate lifecycle failure");

    const restarted = await startFlueRoleRuntime({ providers: [faux.provider], env: {} });
    await restarted.stop();
  });
});
