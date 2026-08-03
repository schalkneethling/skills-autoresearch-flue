import { fileURLToPath } from "node:url";
import { normalizeAnalysisResponse } from "../src/determinization/analyzer.js";
import { loadDeterministicAssetCatalog } from "../src/determinization/catalog.js";
import { renderDeterminizationReport } from "../src/determinization/report.js";
import {
  DETERMINIZATION_SCHEMA_VERSION,
  canonicalAnalysisSha256,
  serializeAnalysisOpportunities
} from "../src/determinization/schemas.js";
import { validateCanonicalAnalysis } from "../src/determinization/validation.js";

const catalogPath = fileURLToPath(new URL("../catalog/deterministic-assets/catalog.json", import.meta.url));

function conciseResponse(recommendations?: unknown[]) {
  return {
    schema_version: DETERMINIZATION_SCHEMA_VERSION,
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

function configurableLanguageToolRecommendation() {
  return {
    relationship: "configurable",
    asset_kind: "languagetool",
    catalog_asset_id: "catalog_languagetool_project_configuration",
    proposed_name: "LanguageTool project configuration",
    contribution: "Project configuration may select applicable rules.",
    confidence: "medium",
    expected_improvement: "May make selected checks repeatable.",
    supporting_evidence: ["The catalog describes a configurable capability."],
    limitations: ["Applicable rules still require evidence."],
    alternative_assessments: [
      {
        relationship: "existing",
        catalog_asset_ids: ["catalog_languagetool_existing_families"],
        conclusion: "insufficient",
        rationale: "Existing families require project-specific selection."
      }
    ]
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

test("maps every catalog-owned recommendation field to exact catalog metadata", async () => {
  const catalog = await loadDeterministicAssetCatalog(catalogPath);
  const catalogAsset = catalog.assets.find(({ id }) => id === "catalog_text_metrics");
  const document = normalizeAnalysisResponse(conciseResponse(), catalog);
  const recommendation = document.opportunities[0].recommendations.find(
    ({ catalog_asset_id }) => catalog_asset_id === catalogAsset?.id
  );

  expect(catalogAsset).toBeDefined();
  expect(recommendation).toMatchObject({
    proposed_name: catalogAsset?.name,
    contribution: catalogAsset?.contribution,
    expected_improvement:
      "Potential improvement requires later evidence and verification; catalog metadata establishes only the stated capability contribution.",
    supporting_evidence: [`Catalog capability evidence basis: ${catalogAsset?.evidence_basis}`],
    limitations: catalogAsset?.limitations.map((limitation) => `Catalog capability limitation: ${limitation}`)
  });
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

test("normalizes composed and decomposed source-reference paths to the same canonical identity", async () => {
  const catalog = await loadDeterministicAssetCatalog(catalogPath);
  const composed = conciseResponse();
  composed.opportunities[0].source_refs[0].path = "skill/caf\u00e9.md";
  const decomposed = structuredClone(composed);
  decomposed.opportunities[0].source_refs[0].path = "skill/cafe\u0301.md";

  const normalizedComposed = normalizeAnalysisResponse(composed, catalog);
  const normalizedDecomposed = normalizeAnalysisResponse(decomposed, catalog);

  expect(normalizedDecomposed.opportunities[0].source_refs[0].path).toBe("skill/caf\u00e9.md");
  expect(serializeAnalysisOpportunities(normalizedDecomposed)).toBe(serializeAnalysisOpportunities(normalizedComposed));
  expect(normalizedDecomposed.opportunities[0].id).toBe(normalizedComposed.opportunities[0].id);
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

test("rejects unknown or incomplete alternative assessment fields", async () => {
  const catalog = await loadDeterministicAssetCatalog(catalogPath);
  const withUnknownField = configurableLanguageToolRecommendation();
  Object.assign(withUnknownField.alternative_assessments[0], { unexpected: true });
  expect(() => normalizeAnalysisResponse(conciseResponse([withUnknownField]), catalog)).toThrow(
    /Alternative assessment 0\.0 contains unsupported fields: unexpected/
  );

  const withoutRationale = configurableLanguageToolRecommendation();
  delete (withoutRationale.alternative_assessments[0] as { rationale?: string }).rationale;
  expect(() => normalizeAnalysisResponse(conciseResponse([withoutRationale]), catalog)).toThrow(
    /Invalid analysis opportunities/
  );
});

test("rejects invalid recommendation identity field types before deriving IDs", async () => {
  const catalog = await loadDeterministicAssetCatalog(catalogPath);
  for (const [field, value, message] of [
    ["relationship", 1, /relationship and asset_kind must be text/],
    ["asset_kind", { kind: "script" }, /relationship and asset_kind must be text/],
    ["catalog_asset_id", { id: "catalog_text_metrics" }, /catalog_asset_id must be text/],
    ["proposed_name", ["Text metrics"], /proposed_name must be text/]
  ] as const) {
    const response = conciseResponse();
    (response.opportunities[0].recommendations[0] as Record<string, unknown>)[field] = value;
    expect(() => normalizeAnalysisResponse(response, catalog)).toThrow(message);
  }
});

test("renders the LanguageTool disclaimer only for opportunities that suggest LanguageTool", async () => {
  const catalog = await loadDeterministicAssetCatalog(catalogPath);
  const withoutLanguageTool = normalizeAnalysisResponse(conciseResponse([metricsRecommendation()]), catalog);
  const withoutLanguageToolHash = canonicalAnalysisSha256(withoutLanguageTool);
  const lineage = {
    schema_version: DETERMINIZATION_SCHEMA_VERSION,
    source_opportunities_sha256: withoutLanguageToolHash,
    opportunity_ids: withoutLanguageTool.opportunities.map(({ id }) => id)
  };
  const disclaimer = "LanguageTool references describe candidate capability families only.";

  expect(renderDeterminizationReport(withoutLanguageTool, lineage)).not.toContain(disclaimer);

  const withLanguageTool = normalizeAnalysisResponse(conciseResponse(), catalog);
  expect(
    renderDeterminizationReport(withLanguageTool, {
      ...lineage,
      source_opportunities_sha256: canonicalAnalysisSha256(withLanguageTool),
      opportunity_ids: withLanguageTool.opportunities.map(({ id }) => id)
    })
  ).toContain(disclaimer);
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
