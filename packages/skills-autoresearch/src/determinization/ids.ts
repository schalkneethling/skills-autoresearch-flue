import { compareCodePoints, sha256 } from "./canonical.js";

export interface OpportunityIdentityInput {
  normalized_requirement: string;
  source_refs: Array<{ path: string; locator?: string }>;
}

export interface RecommendationIdentityInput {
  asset_kind: string;
  catalog_asset_id?: string;
  opportunity_id: string;
  proposed_name?: string;
  relationship: string;
}

function normalizeIdentityText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC").trim().replace(/\s+/gu, " ");
}

function sourceIdentity(source: { path: string; locator?: string }): string {
  if (
    source.path.startsWith("/") ||
    source.path.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(source.path) ||
    source.path.includes("\\") ||
    source.path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new Error(`Stable IDs require a normalized source-relative POSIX path: ${source.path}`);
  }
  return JSON.stringify([source.path.normalize("NFC"), normalizeIdentityText(source.locator ?? "")]);
}

/** IDs deliberately exclude machine roots and all mutable analysis judgments. */
export function createOpportunityId(input: OpportunityIdentityInput): string {
  const sources = input.source_refs.map(sourceIdentity).sort(compareCodePoints);
  const identity = JSON.stringify({
    normalized_requirement: normalizeIdentityText(input.normalized_requirement),
    source_refs: sources
  });
  return `opp_${sha256(identity).slice(0, 20)}`;
}

export function createRecommendationId(input: RecommendationIdentityInput): string {
  let proposedAssetIdentity: string | null = null;
  if (input.relationship === "new") {
    if (input.proposed_name === undefined) {
      throw new Error("New deterministic assets require a proposed name for stable identity");
    }
    proposedAssetIdentity = normalizeIdentityText(input.proposed_name);
  }
  const identity = JSON.stringify({
    asset_kind: input.asset_kind,
    catalog_asset_id: input.catalog_asset_id ?? null,
    opportunity_id: input.opportunity_id,
    proposed_asset_identity: proposedAssetIdentity,
    relationship: input.relationship
  });
  return `asset_${sha256(identity).slice(0, 20)}`;
}
