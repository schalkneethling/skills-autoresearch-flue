import { serializeCanonical } from "./canonical.js";
import {
  DETERMINIZATION_SCHEMA_VERSION,
  type AnalysisOpportunitiesDocument,
  type AssetRelationship
} from "./schemas.js";

export interface DerivativeLineage {
  schema_version: typeof DETERMINIZATION_SCHEMA_VERSION;
  source_opportunities_sha256: string;
  opportunity_ids: string[];
}

export interface ResearchAssetRequest {
  asset_id: string;
  relationship: AssetRelationship;
  asset_kind: string;
  catalog_asset_id?: string;
  contribution: string;
  supporting_evidence: string[];
  evidence_questions: string[];
  known_limitations: string[];
}

export interface ResearchOpportunityRequest {
  opportunity_id: string;
  normalized_requirement: string;
  source_refs: Array<{ path: string; locator?: string; evidence_kind: string }>;
  supporting_evidence: string[];
  limitations: string[];
  suggested_assets: ResearchAssetRequest[];
}

export interface ResearchRequest extends DerivativeLineage {
  opportunity_requests: ResearchOpportunityRequest[];
  constraints: string[];
}

function evidenceQuestions(
  relationship: AssetRelationship,
  assetName: string,
  catalogAssetId: string | undefined
): string[] {
  const identity = catalogAssetId ? `${assetName} (${catalogAssetId})` : assetName;
  const questions = [
    `Which authoritative sources establish whether ${identity} can contribute to this requirement?`,
    `Which product or rule versions, language variants, runtime constraints, and configuration are relevant to ${identity}, if any?`,
    `What limitations, false-positive risks, and remaining human judgment apply to ${identity}?`
  ];
  if (relationship === "new") {
    questions.push(
      `What evidence demonstrates that existing, configurable, and extensible catalog assets are insufficient before ${identity} is created?`
    );
  }
  return questions;
}

export function createResearchRequest(
  opportunities: AnalysisOpportunitiesDocument,
  lineage: DerivativeLineage
): ResearchRequest {
  return {
    ...lineage,
    opportunity_requests: opportunities.opportunities.map((opportunity) => ({
      opportunity_id: opportunity.id,
      normalized_requirement: opportunity.normalized_requirement,
      source_refs: opportunity.source_refs.map((source) => ({ ...source })),
      supporting_evidence: [...opportunity.supporting_evidence],
      limitations: [...opportunity.limitations],
      suggested_assets: opportunity.recommendations.map((asset) => ({
        asset_id: asset.id,
        relationship: asset.relationship,
        asset_kind: asset.asset_kind,
        ...(asset.catalog_asset_id && { catalog_asset_id: asset.catalog_asset_id }),
        contribution: asset.contribution,
        supporting_evidence: [...asset.supporting_evidence],
        evidence_questions: evidenceQuestions(asset.relationship, asset.proposed_name, asset.catalog_asset_id),
        known_limitations: [...asset.limitations]
      }))
    })),
    constraints: [
      "Research is read-only and must not change the skill, context, catalog, opportunities.json, or other analysis artifacts.",
      "Treat every deterministic asset as suggested and unverified.",
      "Use authoritative evidence and record its applicable product or rule version, language variant, and configuration when those facts are available.",
      "Do not invent versions, configuration, rule availability, verification, or adoption status.",
      "Record evidence gaps and remaining human judgment explicitly."
    ]
  };
}

export function serializeResearchRequest(request: ResearchRequest): string {
  return serializeCanonical(request);
}
