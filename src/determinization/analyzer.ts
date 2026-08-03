import type { DeterministicAssetCatalog } from "./catalog.js";
import { validateCatalogReferences } from "./catalog.js";
import { compareCodePoints } from "./canonical.js";
import { createOpportunityId, createRecommendationId } from "./ids.js";
import {
  DETERMINIZATION_SCHEMA_VERSION,
  parseAnalysisOpportunities,
  type AnalysisOpportunitiesDocument
} from "./schemas.js";

type JsonObject = Record<string, unknown>;

const OPPORTUNITY_KEYS = new Set([
  "source_refs",
  "normalized_requirement",
  "origin",
  "classification",
  "current_automation_potential",
  "remaining_human_judgment",
  "recommendations",
  "confidence",
  "expected_improvement",
  "supporting_evidence",
  "limitations"
]);
const RECOMMENDATION_KEYS = new Set([
  "relationship",
  "asset_kind",
  "catalog_asset_id",
  "proposed_name",
  "contribution",
  "confidence",
  "expected_improvement",
  "supporting_evidence",
  "limitations",
  "alternative_assessments",
  "insufficiency_justification"
]);
const SOURCE_REFERENCE_KEYS = new Set(["path", "locator", "evidence_kind"]);

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.sort().join(", ")}`);
}

function unverifiedText(value: unknown, label: string): unknown {
  return typeof value === "string" ? `${label}: ${value}` : value;
}

function unverifiedList(value: unknown, label: string): unknown {
  return Array.isArray(value) ? value.map((item) => unverifiedText(item, label)) : value;
}

function normalizeSourceReferences(value: unknown[], opportunityIndex: number) {
  return value
    .map((rawReference, referenceIndex) => {
      const reference = object(rawReference, `Source reference ${opportunityIndex}.${referenceIndex}`);
      exactKeys(reference, SOURCE_REFERENCE_KEYS, `Source reference ${opportunityIndex}.${referenceIndex}`);
      if (
        typeof reference.path !== "string" ||
        typeof reference.evidence_kind !== "string" ||
        (reference.locator !== undefined && typeof reference.locator !== "string")
      ) {
        throw new Error(`Source reference ${opportunityIndex}.${referenceIndex} has invalid field types`);
      }
      return {
        path: reference.path,
        ...(reference.locator !== undefined && { locator: reference.locator }),
        evidence_kind: reference.evidence_kind
      };
    })
    .sort((left, right) =>
      compareCodePoints(
        `${left.path}\u0000${left.locator ?? ""}\u0000${left.evidence_kind}`,
        `${right.path}\u0000${right.locator ?? ""}\u0000${right.evidence_kind}`
      )
    );
}

function assertOpportunityProvenance(document: AnalysisOpportunitiesDocument): void {
  for (const opportunity of document.opportunities) {
    for (const reference of opportunity.source_refs) {
      const namespace = reference.path.split("/", 1)[0];
      if (namespace !== reference.evidence_kind) {
        throw new Error(
          `Source reference namespace ${namespace} does not match evidence kind ${reference.evidence_kind}`
        );
      }
    }
    const hasSkill = opportunity.source_refs.some(({ evidence_kind }) => evidence_kind === "skill");
    const hasEvaluation = opportunity.source_refs.some(({ evidence_kind }) => evidence_kind === "evaluation");
    const validOrigin =
      (opportunity.origin === "skill_guidance" && hasSkill && !hasEvaluation) ||
      (opportunity.origin === "evaluation_evidence" && hasEvaluation && !hasSkill) ||
      (opportunity.origin === "both" && hasSkill && hasEvaluation);
    if (!validOrigin) {
      throw new Error(`Opportunity ${opportunity.id} origin is inconsistent with skill/evaluation provenance`);
    }
  }
}

/** Converts untrusted transport output into the sole PR1A canonical analysis contract. */
export function normalizeAnalysisResponse(
  response: unknown,
  catalog: DeterministicAssetCatalog
): AnalysisOpportunitiesDocument {
  const root = object(response, "Analysis response");
  exactKeys(root, new Set(["schema_version", "opportunities"]), "Analysis response");
  if (root.schema_version !== DETERMINIZATION_SCHEMA_VERSION)
    throw new Error("Unsupported analysis response schema version");
  if (!Array.isArray(root.opportunities)) throw new Error("Analysis response opportunities must be an array");
  const catalogAssets = new Map(catalog.assets.map((asset) => [asset.id, asset]));

  const opportunities = root.opportunities.map((rawOpportunity, opportunityIndex) => {
    const opportunity = object(rawOpportunity, `Opportunity ${opportunityIndex}`);
    exactKeys(opportunity, OPPORTUNITY_KEYS, `Opportunity ${opportunityIndex}`);
    if (!Array.isArray(opportunity.source_refs))
      throw new Error(`Opportunity ${opportunityIndex} source_refs must be an array`);
    const sourceRefs = normalizeSourceReferences(opportunity.source_refs, opportunityIndex);
    if (typeof opportunity.normalized_requirement !== "string") {
      throw new Error(`Opportunity ${opportunityIndex} normalized_requirement must be text`);
    }
    const id = createOpportunityId({
      normalized_requirement: opportunity.normalized_requirement,
      source_refs: sourceRefs
    });
    if (!Array.isArray(opportunity.recommendations)) {
      throw new Error(`Opportunity ${opportunityIndex} recommendations must be an array`);
    }
    const recommendations = opportunity.recommendations.map((rawRecommendation, recommendationIndex) => {
      const recommendation = object(rawRecommendation, `Recommendation ${opportunityIndex}.${recommendationIndex}`);
      exactKeys(recommendation, RECOMMENDATION_KEYS, `Recommendation ${opportunityIndex}.${recommendationIndex}`);
      const catalogAsset =
        typeof recommendation.catalog_asset_id === "string"
          ? catalogAssets.get(recommendation.catalog_asset_id)
          : undefined;
      const alternativeAssessments = Array.isArray(recommendation.alternative_assessments)
        ? recommendation.alternative_assessments.map((rawAssessment) => {
            const assessment = object(
              rawAssessment,
              `Alternative assessment ${opportunityIndex}.${recommendationIndex}`
            );
            return {
              ...assessment,
              rationale: unverifiedText(assessment.rationale, "Unverified analyzer rationale")
            };
          })
        : recommendation.alternative_assessments;
      return {
        ...recommendation,
        id: createRecommendationId({
          asset_kind: String(recommendation.asset_kind),
          catalog_asset_id:
            recommendation.catalog_asset_id === undefined ? undefined : String(recommendation.catalog_asset_id),
          opportunity_id: id,
          proposed_name: recommendation.proposed_name === undefined ? undefined : String(recommendation.proposed_name),
          relationship: String(recommendation.relationship)
        }),
        ...(catalogAsset
          ? {
              proposed_name: catalogAsset.name,
              contribution: catalogAsset.contribution,
              expected_improvement:
                "Potential improvement requires later evidence and verification; catalog metadata establishes only the stated capability contribution.",
              supporting_evidence: [`Catalog capability evidence basis: ${catalogAsset.evidence_basis}`],
              limitations: catalogAsset.limitations.map((limitation) => `Catalog capability limitation: ${limitation}`)
            }
          : {
              contribution: unverifiedText(recommendation.contribution, "Unverified analyzer hypothesis"),
              expected_improvement: unverifiedText(recommendation.expected_improvement, "Unverified analyzer estimate"),
              supporting_evidence: unverifiedList(recommendation.supporting_evidence, "Unverified analyzer rationale"),
              limitations: unverifiedList(recommendation.limitations, "Unverified analyzer limitation")
            }),
        alternative_assessments: alternativeAssessments,
        ...(recommendation.insufficiency_justification !== undefined && {
          insufficiency_justification: unverifiedText(
            recommendation.insufficiency_justification,
            "Unverified analyzer justification"
          )
        }),
        lifecycle_status: "suggested"
      };
    });
    return {
      ...opportunity,
      id,
      source_refs: sourceRefs,
      remaining_human_judgment: unverifiedText(opportunity.remaining_human_judgment, "Unverified analyzer judgment"),
      expected_improvement: unverifiedText(opportunity.expected_improvement, "Unverified analyzer estimate"),
      supporting_evidence: unverifiedList(opportunity.supporting_evidence, "Unverified analyzer rationale"),
      limitations: unverifiedList(opportunity.limitations, "Unverified analyzer limitation"),
      recommendations,
      lifecycle_status: "suggested"
    };
  });
  const document = parseAnalysisOpportunities({ schema_version: DETERMINIZATION_SCHEMA_VERSION, opportunities });
  validateCatalogReferences(document, catalog);
  assertOpportunityProvenance(document);
  return document;
}
