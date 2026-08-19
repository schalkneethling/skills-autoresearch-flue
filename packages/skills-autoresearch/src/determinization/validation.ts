import type { DeterministicAssetCatalog } from "./catalog.js";
import { validateCatalogReferences } from "./catalog.js";
import { canonicalAnalysisSha256, parseAnalysisOpportunities, type AnalysisOpportunitiesDocument } from "./schemas.js";
import { assertOpportunityProvenance } from "./analyzer.js";

export function validateCanonicalAnalysis(
  value: unknown,
  catalog: DeterministicAssetCatalog,
  expectedSha256?: string
): AnalysisOpportunitiesDocument {
  const document = parseAnalysisOpportunities(value);
  validateCatalogReferences(document, catalog);
  assertOpportunityProvenance(document);
  if (expectedSha256 !== undefined && canonicalAnalysisSha256(document) !== expectedSha256) {
    throw new Error("Canonical opportunities hash mismatch");
  }
  return document;
}
