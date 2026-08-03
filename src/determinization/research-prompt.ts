import type { ResearchRequest } from "./research-request.js";

function markdownText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .normalize("NFC")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/([\\`*_[\]<>#|])/gu, "\\$1");
}

export function renderResearchPrompt(request: ResearchRequest): string {
  const opportunities = request.opportunity_requests.flatMap((opportunity) => [
    `## ${opportunity.opportunity_id}`,
    "",
    `Requirement: ${markdownText(opportunity.normalized_requirement)}`,
    "",
    "Source references:",
    ...opportunity.source_refs.map(
      (source) =>
        `- ${markdownText(`${source.path} [${source.evidence_kind}]${source.locator ? ` — ${source.locator}` : ""}`)}`
    ),
    "",
    "Analyzer rationale (unverified):",
    ...opportunity.supporting_evidence.map((evidence) => `- ${markdownText(evidence)}`),
    "",
    "Known limitations:",
    ...opportunity.limitations.map((limitation) => `- ${markdownText(limitation)}`),
    "",
    "Suggested assets and evidence gaps:",
    ...opportunity.suggested_assets.flatMap((asset) => [
      `- ${markdownText(`${asset.asset_id} (${asset.relationship}, ${asset.asset_kind}${asset.catalog_asset_id ? `, ${asset.catalog_asset_id}` : ""})`)}`,
      `  - Contribution: ${markdownText(asset.contribution)}`,
      ...asset.supporting_evidence.map((evidence) => `  - Existing evidence: ${markdownText(evidence)}`),
      ...asset.evidence_questions.map((question) => `  - ${markdownText(question)}`),
      ...asset.known_limitations.map((limitation) => `  - Known limitation: ${markdownText(limitation)}`)
    ]),
    ""
  ]);
  return [
    "# Determinization evidence research",
    "",
    `schema_version: ${request.schema_version}`,
    `source_opportunities_sha256: ${request.source_opportunities_sha256}`,
    `opportunity_ids: ${request.opportunity_ids.join(", ")}`,
    "",
    "This is a read-only evidence request. Do not modify the skill, context, catalog, opportunities.json, or any other analysis artifact.",
    "All assets are suggested and unverified. Use authoritative sources; establish relevant version, language variant, and configuration facts when available, and never invent them.",
    "",
    ...opportunities,
    "## Required response discipline",
    "",
    ...request.constraints.map((constraint) => `- ${markdownText(constraint)}`),
    ""
  ]
    .join("\n")
    .replace(/\n*$/u, "\n");
}
