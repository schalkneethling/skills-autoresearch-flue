import type { DeterministicAssetCatalog } from "./catalog.js";

export interface AnalysisPromptInput {
  files: Array<{ path: string; contents: string }>;
  catalog: DeterministicAssetCatalog;
}

export function buildDeterminizationAnalysisPrompt(input: AnalysisPromptInput): string {
  const catalog = input.catalog.assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    domain: asset.domain,
    asset_kind: asset.asset_kind,
    capability_level: asset.capability_level,
    contribution: asset.contribution,
    applicability: asset.applicability,
    evidence_basis: asset.evidence_basis,
    limitations: asset.limitations
  }));
  const files = input.files
    .map(({ path, contents }) => [`### ${path}`, "", "```text", contents.replace(/```/gu, "` ` `"), "```"].join("\n"))
    .join("\n\n");
  return [
    "Analyze the supplied skill guidance and evaluation evidence for deterministic opportunities.",
    "This is read-only Stage A. Do not modify files, execute tools, research the web, produce patches, verify assets, or claim adoption.",
    "Every recommendation is only suggested. Existing catalog entries are capability families, not proof that a concrete rule is installed, configured, useful, or verified.",
    "Evaluate reusable assets in order: existing, configurable, extensible, then new. A configurable recommendation must assess existing; an extensible recommendation must assess existing and configurable; a new recommendation must assess all three and explain why they are insufficient or not applicable.",
    "Preserve human editorial judgment. In particular, concision is only partially deterministic: metrics and LanguageTool capability families may contribute, custom LanguageTool rules may add value, and editorial judgment remains.",
    "Return JSON only, with schema_version 1.0.0 and an opportunities array. Do not return IDs or lifecycle fields; the harness owns them.",
    "Each opportunity must contain source_refs, normalized_requirement, origin, classification, current_automation_potential, remaining_human_judgment, recommendations, confidence, expected_improvement, supporting_evidence, and limitations.",
    "Each source ref uses a listed logical path and matching evidence_kind: skill, evaluation, reference, or context. origin is skill_guidance, evaluation_evidence, or both and must agree with those refs.",
    "Each recommendation contains relationship, asset_kind, optional catalog_asset_id, proposed_name, contribution, confidence, expected_improvement, supporting_evidence, limitations, alternative_assessments, and optional insufficiency_justification.",
    "Allowed asset kinds: languagetool, vale, eslint, remark, tree_sitter, json_schema, typescript_check, codemod, script, ci_validation, generator, repository_validator.",
    "Alternative assessments contain relationship, catalog_asset_ids, conclusion (insufficient or not_applicable), and rationale.",
    "",
    "## Reusable deterministic-asset catalog",
    "",
    JSON.stringify(catalog, null, 2),
    "",
    "## Selected read-only inputs",
    "",
    files
  ].join("\n");
}
