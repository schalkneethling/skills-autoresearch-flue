import * as v from "valibot";
import {
  createOpportunityId,
  createRecommendationId
} from "../packages/skills-autoresearch/src/determinization/ids.js";
import {
  AnalysisOpportunitiesDocumentSchema,
  AnalysisOpportunitySchema,
  DerivativeLineageHeaderSchema,
  assertLifecycleAuthority,
  parseAnalysisOpportunities
} from "../packages/skills-autoresearch/src/determinization/schemas.js";

function opportunity(overrides: Record<string, unknown> = {}) {
  const source_refs = [
    { path: "seed-skill/SKILL.md", locator: "instruction:concise", evidence_kind: "skill" as const }
  ];
  const normalized_requirement = "Keep the output concise.";
  const id = createOpportunityId({ source_refs, normalized_requirement });
  const recommendationBase = {
    relationship: "existing" as const,
    asset_kind: "script" as const,
    catalog_asset_id: "catalog_text_metrics",
    proposed_name: "Text metrics",
    contribution: "Word and sentence counts can contribute bounded signals.",
    confidence: "high" as const,
    expected_improvement: "Adds consistent measurements.",
    supporting_evidence: ["The requirement asks for concise output."],
    limitations: ["Metrics do not establish editorial quality."],
    alternative_assessments: [],
    lifecycle_status: "suggested" as const
  };
  const recommendation = {
    id: createRecommendationId({ ...recommendationBase, opportunity_id: id }),
    ...recommendationBase
  };
  return {
    id,
    source_refs,
    normalized_requirement,
    origin: "skill_guidance" as const,
    classification: "partially_deterministic" as const,
    current_automation_potential: "medium" as const,
    remaining_human_judgment: "An editor must judge whether the result is useful and appropriately concise.",
    recommendations: [recommendation],
    confidence: "high" as const,
    expected_improvement: "Repeatable signals reduce inconsistent review.",
    supporting_evidence: ["Conciseness combines measurable length with editorial judgment."],
    limitations: ["No deterministic asset fully establishes concision."],
    lifecycle_status: "suggested" as const,
    ...overrides
  };
}

test("accepts strict analysis opportunities at the analysis-authorized lifecycle state", () => {
  const parsed = parseAnalysisOpportunities({ schema_version: "1.0.0", opportunities: [opportunity()] });
  expect(parsed.opportunities[0].classification).toBe("partially_deterministic");
  expect(() =>
    parseAnalysisOpportunities({ schema_version: "1.0.0", opportunities: [opportunity({ unexpected: true })] })
  ).toThrow(/Invalid analysis opportunities/);
  expect(v.safeParse(AnalysisOpportunitySchema, opportunity({ origin: "model_inference" })).success).toBe(false);
});

test("rejects unsupported schemas, absolute source paths, and model-invented IDs", () => {
  expect(v.safeParse(AnalysisOpportunitiesDocumentSchema, { schema_version: "2.0.0", opportunities: [] }).success).toBe(
    false
  );
  expect(
    v.safeParse(
      AnalysisOpportunitySchema,
      opportunity({
        source_refs: [{ path: "/tmp/project/SKILL.md", evidence_kind: "skill" }]
      })
    ).success
  ).toBe(false);
  expect(v.safeParse(AnalysisOpportunitySchema, opportunity({ id: "opp_model_supplied" })).success).toBe(false);
});

test("rejects duplicate opportunity and recommendation IDs", () => {
  const one = opportunity();
  expect(
    v.safeParse(AnalysisOpportunitiesDocumentSchema, {
      schema_version: "1.0.0",
      opportunities: [one, one]
    }).success
  ).toBe(false);
  expect(
    v.safeParse(
      AnalysisOpportunitySchema,
      opportunity({
        recommendations: [one.recommendations[0], one.recommendations[0]]
      })
    ).success
  ).toBe(false);
});

test("enforces lifecycle stage authority and analysis-only suggested output", () => {
  expect(() => assertLifecycleAuthority("analysis", "suggested")).not.toThrow();
  expect(() => assertLifecycleAuthority("analysis", "verified")).toThrow(/cannot produce/);
  expect(() => assertLifecycleAuthority("verification", "verified")).not.toThrow();
  expect(v.safeParse(AnalysisOpportunitySchema, opportunity({ lifecycle_status: "evidence_gathered" })).success).toBe(
    false
  );
});

test("enforces catalog priority and requires justification before suggesting a new asset", () => {
  const base = opportunity();
  const newBase = {
    relationship: "new" as const,
    asset_kind: "repository_validator" as const,
    proposed_name: "Project concision validator",
    contribution: "Could enforce a project threshold.",
    confidence: "low" as const,
    expected_improvement: "May provide a consistent boundary.",
    supporting_evidence: ["The repository has a project-specific convention."],
    limitations: ["Threshold quality is unverified."],
    alternative_assessments: [],
    lifecycle_status: "suggested" as const
  };
  const unjustified = {
    id: createRecommendationId({ ...newBase, opportunity_id: base.id }),
    ...newBase
  };
  expect(v.safeParse(AnalysisOpportunitySchema, opportunity({ recommendations: [unjustified] })).success).toBe(false);

  const justified = {
    ...unjustified,
    alternative_assessments: [
      {
        relationship: "existing" as const,
        catalog_asset_ids: ["catalog_text_metrics"],
        conclusion: "insufficient" as const,
        rationale: "Metrics cannot encode the project policy."
      },
      {
        relationship: "configurable" as const,
        catalog_asset_ids: ["catalog_languagetool_project_configuration"],
        conclusion: "insufficient" as const,
        rationale: "Configuration cannot add the project-specific policy."
      },
      {
        relationship: "extensible" as const,
        catalog_asset_ids: ["catalog_languagetool_custom_rules"],
        conclusion: "insufficient" as const,
        rationale: "The required signal is not a text-pattern rule."
      }
    ],
    insufficiency_justification: "All applicable reusable paths leave the project-specific invariant unenforced."
  };
  expect(
    v.safeParse(
      AnalysisOpportunitySchema,
      opportunity({
        recommendations: [justified, base.recommendations[0]]
      })
    ).success
  ).toBe(true);
  expect(
    v.safeParse(
      AnalysisOpportunitySchema,
      opportunity({
        recommendations: [base.recommendations[0], justified]
      })
    ).success
  ).toBe(true);

  expect(
    v.safeParse(
      AnalysisOpportunitySchema,
      opportunity({ recommendations: [{ ...justified, catalog_asset_id: "catalog_text_metrics" }] })
    ).success
  ).toBe(false);
  expect(
    v.safeParse(
      AnalysisOpportunitySchema,
      opportunity({ recommendations: [{ ...justified, insufficiency_justification: " \t\n" }] })
    ).success
  ).toBe(false);
  expect(
    v.safeParse(
      AnalysisOpportunitySchema,
      opportunity({
        recommendations: [
          {
            ...justified,
            alternative_assessments: [
              { ...justified.alternative_assessments[0], rationale: "   " },
              ...justified.alternative_assessments.slice(1)
            ]
          }
        ]
      })
    ).success
  ).toBe(false);
  expect(
    v.safeParse(
      AnalysisOpportunitySchema,
      opportunity({
        recommendations: [{ ...base.recommendations[0], insufficiency_justification: "Not allowed." }]
      })
    ).success
  ).toBe(false);
});

test("requires every lower catalog tier in exact order", () => {
  const base = opportunity();
  const configurableBase = {
    ...base.recommendations[0],
    relationship: "configurable" as const,
    asset_kind: "languagetool" as const,
    catalog_asset_id: "catalog_languagetool_project_configuration",
    alternative_assessments: [
      {
        relationship: "existing" as const,
        catalog_asset_ids: ["catalog_languagetool_existing_families"],
        conclusion: "insufficient" as const,
        rationale: "Existing families do not encode the policy."
      }
    ]
  };
  const configurable = {
    ...configurableBase,
    id: createRecommendationId({ ...configurableBase, opportunity_id: base.id })
  };
  expect(v.safeParse(AnalysisOpportunitySchema, opportunity({ recommendations: [configurable] })).success).toBe(true);
  expect(
    v.safeParse(
      AnalysisOpportunitySchema,
      opportunity({ recommendations: [{ ...configurable, alternative_assessments: [] }] })
    ).success
  ).toBe(false);

  const invalidInsufficient = {
    ...configurable,
    alternative_assessments: [
      {
        relationship: "existing" as const,
        catalog_asset_ids: [],
        conclusion: "insufficient" as const,
        rationale: "Missing evidence."
      }
    ]
  };
  expect(v.safeParse(AnalysisOpportunitySchema, opportunity({ recommendations: [invalidInsufficient] })).success).toBe(
    false
  );
  const invalidNotApplicable = {
    ...configurable,
    alternative_assessments: [
      {
        relationship: "existing" as const,
        catalog_asset_ids: ["catalog_languagetool_existing_families"],
        conclusion: "not_applicable" as const,
        rationale: "Contradictory evidence."
      }
    ]
  };
  expect(v.safeParse(AnalysisOpportunitySchema, opportunity({ recommendations: [invalidNotApplicable] })).success).toBe(
    false
  );
  expect(
    v.safeParse(
      AnalysisOpportunitySchema,
      opportunity({
        recommendations: [
          {
            ...configurable,
            alternative_assessments: [
              {
                ...configurable.alternative_assessments[0],
                catalog_asset_ids: ["catalog_languagetool_existing_families", "catalog_languagetool_existing_families"]
              }
            ]
          }
        ]
      })
    ).success
  ).toBe(false);
});

test("rejects duplicate canonical source references", () => {
  const base = opportunity();
  const source_refs = [
    { path: "reference/café.md", locator: "section\r\n", evidence_kind: "reference" as const },
    { path: "reference/cafe\u0301.md", locator: "section\n", evidence_kind: "reference" as const }
  ];
  const id = createOpportunityId({ source_refs, normalized_requirement: base.normalized_requirement });
  const recommendations = base.recommendations.map((recommendation) => ({
    ...recommendation,
    id: createRecommendationId({ ...recommendation, opportunity_id: id })
  }));
  const result = v.safeParse(AnalysisOpportunitySchema, { ...base, id, source_refs, recommendations });
  expect(result.success).toBe(false);
  if (!result.success)
    expect(result.issues.map(({ message }) => message)).toContain(
      "Duplicate canonical source references are not allowed"
    );
});

test("validates the strict derivative lineage header", () => {
  const valid = {
    schema_version: "1.0.0",
    source_opportunities_sha256: "a".repeat(64),
    opportunity_ids: ["opp_00000000000000000000", "opp_ffffffffffffffffffff"]
  };
  expect(v.safeParse(DerivativeLineageHeaderSchema, valid).success).toBe(true);
  expect(v.safeParse(DerivativeLineageHeaderSchema, { ...valid, extra: true }).success).toBe(false);
  expect(v.safeParse(DerivativeLineageHeaderSchema, { ...valid, source_opportunities_sha256: "bad" }).success).toBe(
    false
  );
  expect(
    v.safeParse(DerivativeLineageHeaderSchema, {
      ...valid,
      opportunity_ids: [valid.opportunity_ids[0], valid.opportunity_ids[0]]
    }).success
  ).toBe(false);
  expect(
    v.safeParse(DerivativeLineageHeaderSchema, { ...valid, opportunity_ids: [...valid.opportunity_ids].reverse() })
      .success
  ).toBe(false);
});
