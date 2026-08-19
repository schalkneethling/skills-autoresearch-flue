"use agent";

import { useAgentFinish, useDataWriter, useInitialData, useModel, useResponseFinish, useTool } from "@flue/runtime";
import * as v from "valibot";

import { ModelProduceResponseSchema, EvalScoreSchema, SkillResearchPatchSchema } from "./schemas.js";
import {
  AlternativeAssessmentSchema,
  AssetRelationshipSchema,
  DeterministicAssetKindSchema,
  DETERMINIZATION_SCHEMA_VERSION,
  NonEmptyTextSchema,
  SourceReferenceSchema,
  StableIdSchema
} from "./determinization/schemas.js";

export const PRODUCER_DATA_CHANNEL = "producer-result";
export const JUDGE_DATA_CHANNEL = "judge-result";
export const RESEARCHER_DATA_CHANNEL = "researcher-result";
export const DETERMINIZER_DATA_CHANNEL = "determinizer-result";

const ModelSpecifierSchema = v.pipe(
  v.string(),
  v.check((model) => {
    const segments = model.split("/");
    return segments.length === 2 && segments.every((segment) => segment.length > 0 && !/\s/u.test(segment));
  }, "Expected a model specifier in provider/model format")
);

export const FlueRoleInitialDataSchema = v.strictObject({
  model: ModelSpecifierSchema
});

const NonEmptyTextListSchema = v.pipe(v.array(NonEmptyTextSchema), v.minLength(1));

const RawDeterministicAssetRecommendationSchema = v.strictObject({
  relationship: AssetRelationshipSchema,
  asset_kind: DeterministicAssetKindSchema,
  catalog_asset_id: v.optional(StableIdSchema),
  proposed_name: v.optional(NonEmptyTextSchema),
  contribution: NonEmptyTextSchema,
  confidence: v.picklist(["low", "medium", "high"]),
  expected_improvement: NonEmptyTextSchema,
  supporting_evidence: NonEmptyTextListSchema,
  limitations: NonEmptyTextListSchema,
  alternative_assessments: v.array(AlternativeAssessmentSchema),
  insufficiency_justification: v.optional(NonEmptyTextSchema)
});

const RawAnalysisOpportunitySchema = v.strictObject({
  source_refs: v.pipe(v.array(SourceReferenceSchema), v.minLength(1)),
  normalized_requirement: NonEmptyTextSchema,
  origin: v.picklist(["skill_guidance", "evaluation_evidence", "both"]),
  classification: v.picklist([
    "fully_deterministic",
    "partially_deterministic",
    "human_judgment_required",
    "missing_prerequisite"
  ]),
  current_automation_potential: v.picklist(["none", "low", "medium", "high"]),
  remaining_human_judgment: NonEmptyTextSchema,
  recommendations: v.array(RawDeterministicAssetRecommendationSchema),
  confidence: v.picklist(["low", "medium", "high"]),
  expected_improvement: NonEmptyTextSchema,
  supporting_evidence: NonEmptyTextListSchema,
  limitations: NonEmptyTextListSchema
});

type RawAnalysisOpportunity = v.InferOutput<typeof RawAnalysisOpportunitySchema>;

export type RawDeterminizationAnalysis = {
  schema_version: typeof DETERMINIZATION_SCHEMA_VERSION;
  opportunities: RawAnalysisOpportunity[];
};

/** Model-authored analysis before stable IDs and lifecycle fields are derived locally. */
export const RawDeterminizationAnalysisSchema: v.GenericSchema<
  Record<string, unknown>,
  RawDeterminizationAnalysis
> = v.strictObject({
  schema_version: v.literal(DETERMINIZATION_SCHEMA_VERSION),
  opportunities: v.array(RawAnalysisOpportunitySchema)
});

type StructuredSubmissionSchema = v.GenericSchema<Record<string, unknown>, Record<string, unknown>>;

function useStructuredSubmission(options: {
  channel: string;
  toolName: string;
  description: string;
  schema: StructuredSubmissionSchema;
}): void {
  const writeResult = useDataWriter(options.channel, { schema: options.schema });

  useTool({
    name: options.toolName,
    description: options.description,
    input: options.schema,
    output: options.schema,
    run({ data }) {
      writeResult(data);
      return { output: data, terminate: true };
    }
  });

  useAgentFinish(({ response, append }) => {
    const successfulSubmissions = response.toolCalls.filter(
      (call) => call.tool === options.toolName && !call.isError
    ).length;
    if (successfulSubmissions > 1) {
      throw new Error(`${options.toolName} completed more than once`);
    }
    if (successfulSubmissions === 0) {
      append({
        kind: "signal",
        type: "structured-submission-required",
        body: `Your response is incomplete. Call ${options.toolName} exactly once with a valid result.`
      });
    }
  });

  useResponseFinish(({ response }) => ({ usage: response.usage }));
}

function useRoleModel(): void {
  const { model } = useInitialData<v.InferOutput<typeof FlueRoleInitialDataSchema>>();
  useModel(model);
}

export function Producer() {
  useRoleModel();
  useStructuredSubmission({
    channel: PRODUCER_DATA_CHANNEL,
    toolName: "submit_producer_output",
    description: "Submit the produced artifact files and end the response.",
    schema: ModelProduceResponseSchema
  });

  return [
    "AUTORESEARCH_PRODUCER_ONLY",
    "Follow the supplied skill closely to produce the requested artifact from the supplied inputs and evidence.",
    "Produce concrete output files only.",
    "Never self-score, judge, critique, or improve the governing skill.",
    "Submit exactly once with submit_producer_output."
  ].join("\n");
}
Producer.agentName = "autoresearch-producer";
Producer.initialData = FlueRoleInitialDataSchema;

export function Judge() {
  useRoleModel();
  useStructuredSubmission({
    channel: JUDGE_DATA_CHANNEL,
    toolName: "submit_judge_result",
    description: "Submit the rubric score and end the response.",
    schema: EvalScoreSchema
  });

  return [
    "AUTORESEARCH_JUDGE_ONLY",
    "Act as an independent evaluator and score only the supplied producer outputs against the supplied rubric and evidence.",
    "Do not credit a requirement merely because the governing skill states it; require evidence in the producer outputs.",
    "Give specific rationales and penalize omissions, invented facts, regressions, unsafe assumptions, and unsupported claims.",
    "Do not create, rewrite, or improve the artifact or governing skill.",
    "Submit exactly once with submit_judge_result."
  ].join("\n");
}
Judge.agentName = "autoresearch-judge";
Judge.initialData = FlueRoleInitialDataSchema;

export function Researcher() {
  useRoleModel();
  useStructuredSubmission({
    channel: RESEARCHER_DATA_CHANNEL,
    toolName: "submit_research_patch",
    description: "Submit the proposed skill patch and end the response.",
    schema: SkillResearchPatchSchema
  });

  return [
    "AUTORESEARCH_RESEARCHER_ONLY",
    "Make the smallest effective change to the supplied skill for the observed score gaps.",
    "Preserve the skill's intended scope and avoid overfitting to a single fixture.",
    "Return only the proposed, auditable skill-file patch; application remains owned by the harness.",
    "Submit exactly once with submit_research_patch."
  ].join("\n");
}
Researcher.agentName = "autoresearch-researcher";
Researcher.initialData = FlueRoleInitialDataSchema;

export function Determinizer() {
  useRoleModel();
  useStructuredSubmission({
    channel: DETERMINIZER_DATA_CHANNEL,
    toolName: "submit_determinization_analysis",
    description: "Submit the read-only deterministic-opportunity analysis and end the response.",
    schema: RawDeterminizationAnalysisSchema
  });

  return [
    "AUTORESEARCH_DETERMINIZER_ONLY",
    "Analyze the bounded skill and evaluation evidence for deterministic opportunities.",
    "Remain read-only: do not create, configure, verify, adopt, or apply deterministic assets.",
    "Treat every recommendation as suggested and leave stable IDs and lifecycle fields to the harness.",
    "Submit exactly once with submit_determinization_analysis."
  ].join("\n");
}
Determinizer.agentName = "autoresearch-determinizer";
Determinizer.initialData = FlueRoleInitialDataSchema;
