import { resolve } from "node:path";
import { normalizeAnalysisResponse } from "../src/determinization/analyzer.js";
import { loadDeterministicAssetCatalog } from "../src/determinization/catalog.js";
import { canonicalAnalysisSha256, serializeAnalysisOpportunities } from "../src/determinization/schemas.js";
import { validateCanonicalAnalysis } from "../src/determinization/validation.js";

const catalogPath = resolve("catalog/deterministic-assets/catalog.json");

function conciseResponse(recommendations?: unknown[]) {
  return {
    schema_version: "1.0.0",
    opportunities: [
      {
        source_refs: [{ path: "skill/SKILL.md", locator: "Keep the output concise.", evidence_kind: "skill" }],
        normalized_requirement: "Keep the output concise.",
        origin: "skill_guidance",
        classification: "partially_deterministic",
        current_automation_potential: "medium",
        remaining_human_judgment:
          "Editorial judgment must determine whether the result is useful and appropriately concise.",
        recommendations: recommendations ?? [metricsRecommendation(), languageToolRecommendation()],
        confidence: "high",
        expected_improvement: "Repeatable signals can reduce inconsistent review without replacing an editor.",
        supporting_evidence: ["Length is measurable, while usefulness and clarity remain contextual."],
        limitations: ["No deterministic asset fully establishes concision."]
      }
    ]
  };
}

function metricsRecommendation() {
  return {
    relationship: "existing",
    asset_kind: "script",
    catalog_asset_id: "catalog_text_metrics",
    proposed_name: "Text metrics",
    contribution: "Word and sentence counts can provide partial signals.",
    confidence: "high",
    expected_improvement: "Adds consistent measurements.",
    supporting_evidence: ["Length is directly measurable."],
    limitations: ["Metrics do not establish editorial quality."],
    alternative_assessments: []
  };
}

function languageToolRecommendation() {
  return {
    relationship: "existing",
    asset_kind: "languagetool",
    catalog_asset_id: "catalog_languagetool_existing_families",
    proposed_name: "LanguageTool capability families",
    contribution: "Existing style signals may contribute after later evidence identifies applicable rules.",
    confidence: "medium",
    expected_improvement: "May add repeatable style warnings.",
    supporting_evidence: ["The catalog describes a candidate capability family."],
    limitations: ["No specific rule is established or verified; editorial judgment remains."],
    alternative_assessments: []
  };
}

test("normalizes untrusted transport output into stable local IDs regardless of response order", async () => {
  const catalog = await loadDeterministicAssetCatalog(catalogPath);
  const forwardResponse = conciseResponse();
  const second = structuredClone(forwardResponse.opportunities[0]);
  second.normalized_requirement = "Focus on what changed.";
  second.source_refs[0].locator = "Focus on what changed.";
  forwardResponse.opportunities.push(second);
  const reversedResponse = structuredClone(forwardResponse);
  reversedResponse.opportunities.reverse();
  reversedResponse.opportunities.forEach((opportunity) => opportunity.recommendations.reverse());
  const forward = normalizeAnalysisResponse(forwardResponse, catalog);
  const reversed = normalizeAnalysisResponse(reversedResponse, catalog);
  expect(serializeAnalysisOpportunities(forward)).toBe(serializeAnalysisOpportunities(reversed));
  expect(canonicalAnalysisSha256(forward)).toBe(canonicalAnalysisSha256(reversed));
  expect(forward.opportunities[0].id).toMatch(/^opp_[a-f0-9]{20}$/);
  expect(
    forward.opportunities[0].recommendations.every(({ lifecycle_status }) => lifecycle_status === "suggested")
  ).toBe(true);
});

test("sorts source references canonically and preserves the same bytes and hash", async () => {
  const catalog = await loadDeterministicAssetCatalog(catalogPath);
  const forward = conciseResponse();
  forward.opportunities[0].origin = "both";
  forward.opportunities[0].source_refs.push({
    path: "evaluation/eval-cases.json",
    locator: "case:concise",
    evidence_kind: "evaluation"
  });
  const reversed = structuredClone(forward);
  reversed.opportunities[0].source_refs.reverse();
  const normalizedForward = normalizeAnalysisResponse(forward, catalog);
  const normalizedReversed = normalizeAnalysisResponse(reversed, catalog);
  expect(serializeAnalysisOpportunities(normalizedForward)).toBe(serializeAnalysisOpportunities(normalizedReversed));
  expect(canonicalAnalysisSha256(normalizedForward)).toBe(canonicalAnalysisSha256(normalizedReversed));
});

test("rejects mismatched namespaces, inconsistent origins, catalog provenance, and supplemental-only provenance", async () => {
  const catalog = await loadDeterministicAssetCatalog(catalogPath);

  const mismatched = conciseResponse();
  mismatched.opportunities[0].source_refs[0].evidence_kind = "evaluation";
  mismatched.opportunities[0].origin = "evaluation_evidence";
  expect(() => normalizeAnalysisResponse(mismatched, catalog)).toThrow(/namespace skill does not match/);

  const wrongOrigin = conciseResponse();
  wrongOrigin.opportunities[0].origin = "evaluation_evidence";
  expect(() => normalizeAnalysisResponse(wrongOrigin, catalog)).toThrow(/origin is inconsistent/);

  const catalogSource = conciseResponse();
  catalogSource.opportunities[0].source_refs[0].path = "catalog/language.json";
  expect(() => normalizeAnalysisResponse(catalogSource, catalog)).toThrow(/namespace catalog does not match/);

  const contextOnly = conciseResponse();
  contextOnly.opportunities[0].source_refs = [
    { path: "context/rubric.md", locator: "concise", evidence_kind: "context" }
  ];
  expect(() => normalizeAnalysisResponse(contextOnly, catalog)).toThrow(/origin is inconsistent/);
});

test("rejects transport IDs, lifecycle claims, unsupported schemas, and unknown catalog assets", async () => {
  const catalog = await loadDeterministicAssetCatalog(catalogPath);
  const withOpportunityId = conciseResponse() as ReturnType<typeof conciseResponse> & {
    opportunities: Array<Record<string, unknown>>;
  };
  withOpportunityId.opportunities[0].id = "opp_model_owned";
  expect(() => normalizeAnalysisResponse(withOpportunityId, catalog)).toThrow(/unsupported fields: id/);

  const withLifecycle = conciseResponse();
  Object.assign(withLifecycle.opportunities[0].recommendations[0] as Record<string, unknown>, {
    lifecycle_status: "verified"
  });
  expect(() => normalizeAnalysisResponse(withLifecycle, catalog)).toThrow(/unsupported fields: lifecycle_status/);
  expect(() => normalizeAnalysisResponse({ ...conciseResponse(), schema_version: "2.0.0" }, catalog)).toThrow(
    /Unsupported analysis response schema/
  );

  const unknown = conciseResponse();
  (unknown.opportunities[0].recommendations[0] as Record<string, unknown>).catalog_asset_id = "catalog_unknown_asset";
  expect(() => normalizeAnalysisResponse(unknown, catalog)).toThrow(/Unknown catalog asset/);
});

test("rejects unjustified new assets before they become canonical", async () => {
  const catalog = await loadDeterministicAssetCatalog(catalogPath);
  const newAsset = {
    relationship: "new",
    asset_kind: "repository_validator",
    proposed_name: "Concision policy validator",
    contribution: "Could enforce a project-specific boundary.",
    confidence: "low",
    expected_improvement: "Might add a consistent project signal.",
    supporting_evidence: ["The project has a local convention."],
    limitations: ["Its threshold is not evidenced."],
    alternative_assessments: []
  };
  expect(() => normalizeAnalysisResponse(conciseResponse([newAsset]), catalog)).toThrow(
    /Invalid analysis opportunities/
  );
});

test("fails closed when canonical opportunity bytes do not match their expected hash", async () => {
  const catalog = await loadDeterministicAssetCatalog(catalogPath);
  const document = normalizeAnalysisResponse(conciseResponse(), catalog);
  expect(() => validateCanonicalAnalysis(document, catalog, "0".repeat(64))).toThrow(/hash mismatch/);
});
