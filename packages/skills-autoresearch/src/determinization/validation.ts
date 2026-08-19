import type { DeterministicAssetCatalog } from "./catalog.js";
import { validateCatalogReferences } from "./catalog.js";
import { canonicalAnalysisSha256, parseAnalysisOpportunities, type AnalysisOpportunitiesDocument } from "./schemas.js";

export function validateCanonicalAnalysis(
  value: unknown,
  catalog: DeterministicAssetCatalog,
  expectedSha256?: string
): AnalysisOpportunitiesDocument {
  const document = parseAnalysisOpportunities(value);
  validateCatalogReferences(document, catalog);
  if (expectedSha256 !== undefined && canonicalAnalysisSha256(document) !== expectedSha256) {
    throw new Error("Canonical opportunities hash mismatch");
  }
  return document;
}
