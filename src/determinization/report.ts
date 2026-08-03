import type { AnalysisOpportunitiesDocument } from "./schemas.js";
import type { DerivativeLineage } from "./research-request.js";
import { markdownText } from "./markdown.js";

function bullets(label: string, values: string[], indent = ""): string[] {
  return [`${indent}- ${label}:`, ...values.map((value) => `${indent}  - ${markdownText(value)}`)];
}

export function renderDeterminizationReport(
  document: AnalysisOpportunitiesDocument,
  lineage: DerivativeLineage
): string {
  const sections = document.opportunities.flatMap((opportunity) => {
    const hasLanguageToolAsset = opportunity.recommendations.some(({ asset_kind }) => asset_kind === "languagetool");
    const sources = opportunity.source_refs.map(
      (source) => `${source.path} [${source.evidence_kind}]${source.locator ? ` — ${source.locator}` : ""}`
    );
    const assets = opportunity.recommendations.flatMap((asset) => {
      const alternatives = asset.alternative_assessments.length
        ? asset.alternative_assessments.flatMap((assessment) => [
            `  - ${assessment.relationship}: ${assessment.conclusion}`,
            `    - Catalog assets: ${assessment.catalog_asset_ids.length ? assessment.catalog_asset_ids.join(", ") : "none applicable"}`,
            `    - Rationale: ${markdownText(assessment.rationale)}`
          ])
        : ["  - None required for this relationship tier."];
      return [
        `#### ${asset.id}: ${markdownText(asset.proposed_name)}`,
        "",
        "- Lifecycle: suggested (unverified)",
        `- Relationship: ${asset.relationship}`,
        `- Asset kind: ${asset.asset_kind}`,
        `- Catalog reference: ${asset.catalog_asset_id ?? "none — newly suggested asset"}`,
        `- Contribution: ${markdownText(asset.contribution)}`,
        `- Confidence (unverified analyzer analysis): ${asset.confidence}`,
        `- Expected improvement: ${markdownText(asset.expected_improvement)}`,
        ...bullets("Supporting evidence", asset.supporting_evidence),
        ...bullets("Limitations", asset.limitations),
        "- Lower-tier alternative assessments (unverified analyzer analysis):",
        ...alternatives,
        `- New-asset insufficiency justification: ${asset.insufficiency_justification ? markdownText(asset.insufficiency_justification) : "not applicable"}`,
        ""
      ];
    });
    return [
      `## ${opportunity.id}: ${markdownText(opportunity.normalized_requirement)}`,
      "",
      `- Origin: ${opportunity.origin}`,
      ...bullets("Source references", sources),
      `- Classification (unverified analyzer analysis): ${opportunity.classification}`,
      `- Current automation potential (unverified analyzer analysis): ${opportunity.current_automation_potential}`,
      `- Remaining human judgment: ${markdownText(opportunity.remaining_human_judgment)}`,
      `- Confidence (unverified analyzer analysis): ${opportunity.confidence}`,
      `- Expected improvement: ${markdownText(opportunity.expected_improvement)}`,
      ...bullets("Analyzer rationale (unverified)", opportunity.supporting_evidence),
      ...bullets("Analyzer limitations (unverified)", opportunity.limitations),
      "",
      "### Suggested deterministic assets",
      "",
      ...(assets.length ? assets : ["No deterministic asset was suggested.", ""]),
      ...(hasLanguageToolAsset
        ? [
            "LanguageTool references describe candidate capability families only. A later evidence stage must establish whether relevant rules, versions, language variants, or configuration exist; no LanguageTool signal by itself fully establishes concision or editorial quality."
          ]
        : []),
      ""
    ];
  });
  return [
    "# Determinization opportunity report",
    "",
    `schema_version: ${lineage.schema_version}`,
    `source_opportunities_sha256: ${lineage.source_opportunities_sha256}`,
    `opportunity_ids: ${lineage.opportunity_ids.join(", ")}`,
    "",
    "> Read-only analysis. Every asset below is suggested and unverified. This report does not propose, verify, adopt, apply, or modify an asset.",
    "",
    `Opportunities: ${document.opportunities.length}`,
    "",
    ...sections,
    ""
  ]
    .join("\n")
    .replace(/\n*$/u, "\n");
}
