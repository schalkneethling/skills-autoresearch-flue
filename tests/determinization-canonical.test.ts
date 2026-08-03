import { canonicalSha256, serializeCanonical } from "../src/determinization/canonical.js";
import { createOpportunityId, createRecommendationId } from "../src/determinization/ids.js";
import {
  canonicalAnalysisSha256,
  orderAnalysisOpportunities,
  parseAnalysisOpportunities,
  serializeAnalysisOpportunities
} from "../src/determinization/schemas.js";

test("canonical JSON normalizes Unicode and line endings, sorts keys by code point, and writes one final LF", () => {
  const composed = serializeCanonical({ "\u{1f600}": "e\u0301\r\nline\r", a: 1, Z: [2, 1] });
  const precomposed = serializeCanonical({ "\u{1f600}": "é\nline\n", Z: [2, 1], a: 1 });
  expect(composed).toBe(precomposed);
  expect(composed).toBe('{\n  "Z": [\n    2,\n    1\n  ],\n  "a": 1,\n  "😀": "é\\nline\\n"\n}\n');
  expect(composed.endsWith("\n")).toBe(true);
  expect(composed.endsWith("\n\n")).toBe(false);
  expect(canonicalSha256(JSON.parse(composed))).toBe(canonicalSha256(JSON.parse(precomposed)));
});

test("generic canonicalization preserves array order and rejects unsupported JSON values", () => {
  expect(serializeCanonical({ values: ["b", "a"] })).toContain('"b",\n    "a"');
  expect(() => serializeCanonical({ value: Number.NaN })).toThrow(/non-finite/);
  expect(() => serializeCanonical({ value: undefined })).toThrow(/undefined/);
  expect(() => serializeCanonical({ value: new Date(0) })).toThrow(/non-plain/);
});

test("stable IDs ignore source order, temporary roots, classification, and recommendation prose", () => {
  const first = createOpportunityId({
    normalized_requirement: "Keep the output concise.",
    source_refs: [
      { path: "seed-skill/SKILL.md", locator: "line:2" },
      { path: "evals/rubric.md", locator: "concise" }
    ]
  });
  const reordered = createOpportunityId({
    normalized_requirement: "Keep  the output concise.\r\n",
    source_refs: [
      { path: "evals/rubric.md", locator: "concise" },
      { path: "seed-skill/SKILL.md", locator: "line:2" }
    ]
  });
  expect(first).toBe(reordered);
  expect(first).not.toContain("tmp");
  expect(() =>
    createOpportunityId({
      normalized_requirement: "Keep the output concise.",
      source_refs: [{ path: "/private/tmp/project/seed-skill/SKILL.md" }]
    })
  ).toThrow(/source-relative/);
});

test("opportunity ordering sorts only opportunities and recommendations by stable ID", () => {
  function makeRequirement(requirement: string, path: string) {
    const source_refs = [{ path, evidence_kind: "skill" as const }];
    const id = createOpportunityId({ normalized_requirement: requirement, source_refs });
    const recommendations = ["vale", "script"]
      .map((asset_kind) => {
        const relationship = "existing" as const;
        const catalog_asset_id = asset_kind === "vale" ? "catalog_vale" : "catalog_text_metrics";
        return {
          id: createRecommendationId({ opportunity_id: id, asset_kind, relationship, catalog_asset_id }),
          relationship,
          asset_kind: asset_kind as "vale" | "script",
          catalog_asset_id,
          proposed_name: asset_kind,
          contribution: "Contributes a signal.",
          confidence: "medium" as const,
          expected_improvement: "Improves consistency.",
          supporting_evidence: ["Evidence B", "Evidence A"],
          limitations: ["Limit B", "Limit A"],
          alternative_assessments: [],
          lifecycle_status: "suggested" as const
        };
      })
      .reverse();
    return {
      id,
      source_refs,
      normalized_requirement: requirement,
      origin: "skill_guidance" as const,
      classification: "partially_deterministic" as const,
      current_automation_potential: "medium" as const,
      remaining_human_judgment: "Judgment remains.",
      recommendations,
      confidence: "medium" as const,
      expected_improvement: "Improves consistency.",
      supporting_evidence: ["Evidence B", "Evidence A"],
      limitations: ["Limit B", "Limit A"],
      lifecycle_status: "suggested" as const
    };
  }
  const document = parseAnalysisOpportunities({
    schema_version: "1.0.0",
    opportunities: [makeRequirement("Second", "b.md"), makeRequirement("First", "a.md")]
  });
  const ordered = orderAnalysisOpportunities(document);
  expect(ordered.opportunities.map(({ id }) => id)).toEqual([...ordered.opportunities.map(({ id }) => id)].sort());
  expect(ordered.opportunities[0].recommendations.map(({ id }) => id)).toEqual(
    [...ordered.opportunities[0].recommendations.map(({ id }) => id)].sort()
  );
  expect(ordered.opportunities[0].supporting_evidence).toEqual(["Evidence B", "Evidence A"]);

  const reorderedModelOutput = {
    ...document,
    opportunities: [...document.opportunities]
      .reverse()
      .map((opportunity) => ({ ...opportunity, recommendations: [...opportunity.recommendations].reverse() }))
  };
  expect(serializeAnalysisOpportunities(reorderedModelOutput)).toBe(serializeAnalysisOpportunities(document));
  expect(canonicalAnalysisSha256(reorderedModelOutput)).toBe(canonicalAnalysisSha256(document));
});

test("new-asset IDs distinguish normalized proposed identities while catalog-backed IDs ignore labels", () => {
  const shared = { opportunity_id: "opp_00000000000000000000", asset_kind: "repository_validator" };
  const firstNew = createRecommendationId({
    ...shared,
    relationship: "new",
    proposed_name: "Release policy validator"
  });
  const normalizedNew = createRecommendationId({
    ...shared,
    relationship: "new",
    proposed_name: " Release  policy validator\r\n"
  });
  const distinctNew = createRecommendationId({ ...shared, relationship: "new", proposed_name: "Concision validator" });
  expect(firstNew).toBe(normalizedNew);
  expect(firstNew).not.toBe(distinctNew);

  const catalogBacked = {
    opportunity_id: shared.opportunity_id,
    asset_kind: "script",
    relationship: "existing",
    catalog_asset_id: "catalog_text_metrics"
  };
  expect(createRecommendationId({ ...catalogBacked, proposed_name: "Text metrics" })).toBe(
    createRecommendationId({ ...catalogBacked, proposed_name: "Renamed presentation label" })
  );
});
