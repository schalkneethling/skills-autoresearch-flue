import * as v from "valibot";
import { compareCanonicalIds, serializeCanonical, sha256 } from "./canonical.js";
import { createOpportunityId, createRecommendationId, isPortableSourcePath } from "./ids.js";

export const DETERMINIZATION_SCHEMA_VERSION = "1.0.0" as const;
export const DeterminizationSchemaVersionSchema = v.literal(DETERMINIZATION_SCHEMA_VERSION);

export const LifecycleStatusSchema = v.picklist([
  "suggested",
  "evidence_gathered",
  "proposal_produced",
  "verified",
  "adopted"
]);
export const LifecycleStageSchema = v.picklist(["analysis", "evidence", "proposal", "verification", "adoption"]);

export const LIFECYCLE_STATUS_BY_STAGE = {
  analysis: "suggested",
  evidence: "evidence_gathered",
  proposal: "proposal_produced",
  verification: "verified",
  adoption: "adopted"
} as const;

const PortablePathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.check(isPortableSourcePath, "Expected a normalized, source-relative POSIX path")
);

export const NonEmptyTextSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.check((value) => value.trim().length > 0, "Expected nonblank text")
);
const NonEmptyTextListSchema = v.pipe(v.array(NonEmptyTextSchema), v.minLength(1));
export const StableIdSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u));

export const SourceReferenceSchema = v.strictObject({
  path: PortablePathSchema,
  locator: v.optional(NonEmptyTextSchema),
  evidence_kind: v.picklist(["skill", "evaluation", "reference", "context"])
});

export const AssetRelationshipSchema = v.picklist(["existing", "configurable", "extensible", "new"]);
export type AssetRelationship = v.InferOutput<typeof AssetRelationshipSchema>;
export const DeterministicAssetKindSchema = v.picklist([
  "languagetool",
  "vale",
  "eslint",
  "remark",
  "tree_sitter",
  "json_schema",
  "typescript_check",
  "codemod",
  "script",
  "ci_validation",
  "generator",
  "repository_validator"
]);

export const AlternativeAssessmentSchema = v.pipe(
  v.strictObject({
    relationship: v.picklist(["existing", "configurable", "extensible"]),
    catalog_asset_ids: v.array(StableIdSchema),
    conclusion: v.picklist(["insufficient", "not_applicable"]),
    rationale: NonEmptyTextSchema
  }),
  v.check(
    (assessment) =>
      (assessment.conclusion === "insufficient" && assessment.catalog_asset_ids.length > 0) ||
      (assessment.conclusion === "not_applicable" && assessment.catalog_asset_ids.length === 0),
    "Insufficient assessments require catalog assets; not-applicable assessments cannot reference catalog assets"
  ),
  v.check(
    (assessment) => new Set(assessment.catalog_asset_ids).size === assessment.catalog_asset_ids.length,
    "Duplicate catalog asset IDs are not allowed within an alternative assessment"
  )
);

const REQUIRED_ASSESSMENTS = {
  existing: [],
  configurable: ["existing"],
  extensible: ["existing", "configurable"],
  new: ["existing", "configurable", "extensible"]
} as const;

export const DeterministicAssetRecommendationSchema = v.pipe(
  v.strictObject({
    id: StableIdSchema,
    relationship: AssetRelationshipSchema,
    asset_kind: DeterministicAssetKindSchema,
    catalog_asset_id: v.optional(StableIdSchema),
    proposed_name: NonEmptyTextSchema,
    contribution: NonEmptyTextSchema,
    confidence: v.picklist(["low", "medium", "high"]),
    expected_improvement: NonEmptyTextSchema,
    supporting_evidence: NonEmptyTextListSchema,
    limitations: NonEmptyTextListSchema,
    alternative_assessments: v.array(AlternativeAssessmentSchema),
    insufficiency_justification: v.optional(NonEmptyTextSchema),
    lifecycle_status: v.literal("suggested")
  }),
  v.check(
    (recommendation) =>
      recommendation.alternative_assessments.every(
        (assessment, index) => assessment.relationship === REQUIRED_ASSESSMENTS[recommendation.relationship][index]
      ) && recommendation.alternative_assessments.length === REQUIRED_ASSESSMENTS[recommendation.relationship].length,
    "Alternative assessments must cover every lower catalog tier in exact priority order"
  ),
  v.check((recommendation) => {
    if (recommendation.relationship === "new") {
      return recommendation.catalog_asset_id === undefined && recommendation.insufficiency_justification !== undefined;
    }
    return recommendation.catalog_asset_id !== undefined && recommendation.insufficiency_justification === undefined;
  }, "New assets require no catalog reference and an insufficiency justification; catalog-backed assets require a reference and no justification")
);

export const AnalysisOpportunitySchema = v.pipe(
  v.strictObject({
    id: StableIdSchema,
    source_refs: v.pipe(
      v.array(SourceReferenceSchema),
      v.minLength(1),
      v.check(
        (references) =>
          new Set(references.map((reference) => serializeCanonical(reference))).size === references.length,
        "Duplicate canonical source references are not allowed"
      )
    ),
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
    recommendations: v.array(DeterministicAssetRecommendationSchema),
    confidence: v.picklist(["low", "medium", "high"]),
    expected_improvement: NonEmptyTextSchema,
    supporting_evidence: NonEmptyTextListSchema,
    limitations: NonEmptyTextListSchema,
    lifecycle_status: v.literal("suggested")
  }),
  v.check((opportunity) => {
    try {
      return opportunity.id === createOpportunityId(opportunity);
    } catch {
      return false;
    }
  }, "Opportunity ID must be locally derived from portable source identity and normalized requirement"),
  v.check((opportunity) => {
    const ids = opportunity.recommendations.map(({ id }) => id);
    return new Set(ids).size === ids.length;
  }, "Duplicate deterministic-asset recommendation IDs are not allowed"),
  v.check(
    (opportunity) =>
      opportunity.recommendations.every(
        (recommendation) =>
          recommendation.id === createRecommendationId({ ...recommendation, opportunity_id: opportunity.id })
      ),
    "Recommendation IDs must be locally derived from the opportunity and asset identity"
  )
);

export const AnalysisOpportunitiesDocumentSchema = v.pipe(
  v.strictObject({
    schema_version: DeterminizationSchemaVersionSchema,
    opportunities: v.array(AnalysisOpportunitySchema)
  }),
  v.check((document) => {
    const ids = document.opportunities.map(({ id }) => id);
    return new Set(ids).size === ids.length;
  }, "Duplicate opportunity IDs are not allowed")
);

export const DerivativeLineageHeaderSchema = v.pipe(
  v.strictObject({
    schema_version: DeterminizationSchemaVersionSchema,
    source_opportunities_sha256: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u)),
    opportunity_ids: v.array(v.pipe(v.string(), v.regex(/^opp_[a-f0-9]{20}$/u)))
  }),
  v.check(
    (header) => new Set(header.opportunity_ids).size === header.opportunity_ids.length,
    "Duplicate opportunity IDs are not allowed"
  ),
  v.check(
    (header) =>
      header.opportunity_ids.every(
        (id, index) => index === 0 || compareCanonicalIds({ id: header.opportunity_ids[index - 1] }, { id }) < 0
      ),
    "Opportunity IDs must be sorted by canonical code-point order"
  )
);

export type LifecycleStatus = v.InferOutput<typeof LifecycleStatusSchema>;
export type LifecycleStage = v.InferOutput<typeof LifecycleStageSchema>;
export type AnalysisOpportunitiesDocument = v.InferOutput<typeof AnalysisOpportunitiesDocumentSchema>;

export function assertLifecycleAuthority(stage: LifecycleStage, status: LifecycleStatus): void {
  if (LIFECYCLE_STATUS_BY_STAGE[stage] !== status) {
    throw new Error(`Stage ${stage} cannot produce lifecycle status ${status}`);
  }
}

export function parseAnalysisOpportunities(value: unknown): AnalysisOpportunitiesDocument {
  const result = v.safeParse(AnalysisOpportunitiesDocumentSchema, value);
  if (!result.success) {
    throw new Error(`Invalid analysis opportunities: ${result.issues.map((issue) => issue.message).join("; ")}`);
  }
  return result.output;
}

/** Only the two contractually ordered collections are sorted; evidence and source order remain meaningful. */
export function orderAnalysisOpportunities(document: AnalysisOpportunitiesDocument): AnalysisOpportunitiesDocument {
  return {
    ...document,
    opportunities: document.opportunities
      .map((opportunity) => ({
        ...opportunity,
        recommendations: [...opportunity.recommendations].sort(compareCanonicalIds)
      }))
      .sort(compareCanonicalIds)
  };
}

/** The sole safe serialization path for canonical analysis IR. */
export function serializeAnalysisOpportunities(value: unknown): string {
  return serializeCanonical(orderAnalysisOpportunities(parseAnalysisOpportunities(value)));
}

export function canonicalAnalysisSha256(value: unknown): string {
  return sha256(serializeAnalysisOpportunities(value));
}
