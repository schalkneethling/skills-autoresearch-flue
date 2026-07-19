import * as v from "valibot";

export const ModelProviderSchema = v.picklist(["anthropic"]);

export const ModelConfigSchema = v.object({
  provider: ModelProviderSchema,
  name: v.pipe(v.string(), v.minLength(1))
});

export const RoleModelsSchema = v.object({
  producer: v.optional(ModelConfigSchema),
  judge: v.optional(ModelConfigSchema),
  researcher: v.optional(ModelConfigSchema)
});

export const RolesConfigSchema = v.object({
  judge: v.pipe(v.string(), v.minLength(1)),
  skill_builder: v.pipe(v.string(), v.minLength(1))
});

export const TrackSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  eval_type: v.pipe(v.string(), v.minLength(1)),
  role: v.pipe(v.string(), v.minLength(1)),
  target_skill: v.pipe(v.string(), v.minLength(1)),
  requires_description: v.optional(v.boolean(), false)
});

export const ProjectConfigSchema = v.object({
  skill_name: v.pipe(v.string(), v.minLength(1)),
  topic_group: v.pipe(v.string(), v.minLength(1)),
  origin_skill: v.optional(v.pipe(v.string(), v.minLength(1))),
  research_start: v.optional(v.picklist(["seed", "empty"])),
  guidance_skill: v.optional(v.pipe(v.string(), v.minLength(1))),
  target_score: v.pipe(v.number(), v.minValue(0)),
  max_iterations: v.pipe(v.number(), v.integer(), v.minValue(1)),
  max_concurrency: v.pipe(v.number(), v.integer(), v.minValue(1)),
  budget_usd: v.optional(v.pipe(v.number(), v.minValue(0))),
  model: v.optional(ModelConfigSchema),
  models: v.optional(RoleModelsSchema),
  roles: RolesConfigSchema,
  tracks: v.pipe(v.array(TrackSchema), v.minLength(1))
});

export const ScoreDimensionSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  label: v.pipe(v.string(), v.minLength(1)),
  max_score: v.pipe(v.number(), v.minValue(0))
});

export const EvalExpectationSchema = v.record(v.string(), v.unknown());

export const EvalCaseSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  eval_type: v.pipe(v.string(), v.minLength(1)),
  title: v.pipe(v.string(), v.minLength(1)),
  input: v.optional(v.record(v.string(), v.unknown()), {}),
  expectations: v.optional(EvalExpectationSchema, {}),
  scoring_dimensions: v.pipe(v.array(ScoreDimensionSchema), v.minLength(1))
});

export const EvalCasesFileSchema = v.object({
  evals: v.pipe(v.array(EvalCaseSchema), v.minLength(1))
});

export const EvalScoreDimensionSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  score: v.pipe(v.number(), v.minValue(0)),
  max_score: v.pipe(v.number(), v.minValue(0)),
  rationale: v.pipe(v.string(), v.minLength(1))
});

export const EvalScoreSchema = v.object({
  eval_id: v.pipe(v.string(), v.minLength(1)),
  eval_type: v.pipe(v.string(), v.minLength(1)),
  track_id: v.pipe(v.string(), v.minLength(1)),
  total_score: v.pipe(v.number(), v.minValue(0)),
  max_score: v.pipe(v.number(), v.minValue(0)),
  dimensions: v.pipe(v.array(EvalScoreDimensionSchema), v.minLength(1)),
  summary: v.pipe(v.string(), v.minLength(1))
});

export const OutputFileSchema = v.object({
  path: v.pipe(v.string(), v.minLength(1)),
  contents: v.string()
});

export const ModelProduceResponseSchema = v.object({
  output_files: v.pipe(v.array(OutputFileSchema), v.minLength(1))
});

export const SkillMetadataSchema = v.object({
  skillPath: v.pipe(v.string(), v.minLength(1)),
  description: v.pipe(v.string(), v.minLength(1)),
  contentHash: v.pipe(v.string(), v.minLength(1)),
  constructionNotes: v.optional(v.string(), ""),
  changelog: v.optional(v.array(v.string()), [])
});

export const SkillFileChangeSchema = v.object({
  path: v.pipe(v.string(), v.minLength(1)),
  contents: v.string()
});

export const ResourcePlacementSchema = v.picklist(["skill", "reference", "script", "asset"]);

export const ResourceDecisionSchema = v.object({
  path: v.pipe(v.string(), v.minLength(1)),
  placement: ResourcePlacementSchema,
  reason: v.pipe(v.string(), v.minLength(1))
});

export const GuidanceLedgerEntrySchema = v.object({
  iteration: v.pipe(v.number(), v.integer(), v.minValue(1)),
  source: v.pipe(v.string(), v.minLength(1)),
  action: v.picklist(["used", "deferred", "ignored", "requested"]),
  reason: v.pipe(v.string(), v.minLength(1)),
  section: v.optional(v.pipe(v.string(), v.minLength(1))),
  appliedTo: v.optional(v.pipe(v.string(), v.minLength(1)))
});

export const GuidanceLedgerSchema = v.object({
  entries: v.optional(v.array(GuidanceLedgerEntrySchema), [])
});

export const SkillResearchPatchSchema = v.object({
  summary: v.pipe(v.string(), v.minLength(1)),
  guidance: v.optional(v.array(v.omit(GuidanceLedgerEntrySchema, ["iteration"])), []),
  resource_decisions: v.optional(v.array(ResourceDecisionSchema), []),
  changes: v.pipe(v.array(SkillFileChangeSchema), v.minLength(1))
});

export type ModelProvider = v.InferOutput<typeof ModelProviderSchema>;
export type ModelConfig = v.InferOutput<typeof ModelConfigSchema>;
export type RoleModels = v.InferOutput<typeof RoleModelsSchema>;
export type ProjectConfig = v.InferOutput<typeof ProjectConfigSchema>;
export type Track = v.InferOutput<typeof TrackSchema>;
export type EvalCase = v.InferOutput<typeof EvalCaseSchema>;
export type EvalCasesFile = v.InferOutput<typeof EvalCasesFileSchema>;
export type ScoreDimension = v.InferOutput<typeof ScoreDimensionSchema>;
export type EvalScore = v.InferOutput<typeof EvalScoreSchema>;
export type OutputFile = v.InferOutput<typeof OutputFileSchema>;
export type ModelProduceResponse = v.InferOutput<typeof ModelProduceResponseSchema>;
export type SkillMetadata = v.InferOutput<typeof SkillMetadataSchema>;
export type SkillFileChange = v.InferOutput<typeof SkillFileChangeSchema>;
export type ResourcePlacement = v.InferOutput<typeof ResourcePlacementSchema>;
export type ResourceDecision = v.InferOutput<typeof ResourceDecisionSchema>;
export type GuidanceLedgerEntry = v.InferOutput<typeof GuidanceLedgerEntrySchema>;
export type GuidanceLedger = v.InferOutput<typeof GuidanceLedgerSchema>;
export type SkillResearchPatch = v.InferOutput<typeof SkillResearchPatchSchema>;

export function parseWithSchema<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  schema: TSchema,
  value: unknown,
  label: string
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, value);
  if (result.success) {
    return result.output;
  }

  const details = result.issues.map((issue) => `${issue.path?.map((p) => p.key).join(".") || label}: ${issue.message}`);
  throw new Error(`Invalid ${label}: ${details.join("; ")}`);
}
