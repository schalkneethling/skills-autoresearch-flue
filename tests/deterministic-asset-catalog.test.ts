import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import {
  CatalogIndexSchema,
  CatalogDomainDocumentSchema,
  loadDeterministicAssetCatalog,
  validateCatalogReferences
} from "../src/determinization/catalog.js";
import { createOpportunityId, createRecommendationId } from "../src/determinization/ids.js";
import { parseAnalysisOpportunities } from "../src/determinization/schemas.js";

const catalogIndex = fileURLToPath(new URL("../catalog/deterministic-assets/catalog.json", import.meta.url));

function documentWithCatalogReference(catalog_asset_id: string) {
  const source_refs = [{ path: "seed-skill/SKILL.md", evidence_kind: "skill" as const }];
  const normalized_requirement = "Keep the output concise.";
  const id = createOpportunityId({ source_refs, normalized_requirement });
  const recommendationBase = {
    relationship: "existing" as const,
    asset_kind: "script" as const,
    catalog_asset_id,
    proposed_name: "Text metrics",
    contribution: "Metrics may contribute.",
    confidence: "medium" as const,
    expected_improvement: "Provides consistent signals.",
    supporting_evidence: ["Length is measurable."],
    limitations: ["Editorial judgment remains."],
    alternative_assessments: [],
    lifecycle_status: "suggested" as const
  };
  return parseAnalysisOpportunities({
    schema_version: "1.0.0",
    opportunities: [
      {
        id,
        source_refs,
        normalized_requirement,
        origin: "skill_guidance",
        classification: "partially_deterministic",
        current_automation_potential: "medium",
        remaining_human_judgment: "An editor must judge usefulness and concision.",
        recommendations: [
          {
            id: createRecommendationId({ ...recommendationBase, opportunity_id: id }),
            ...recommendationBase
          }
        ],
        confidence: "medium",
        expected_improvement: "Adds repeatability without overclaiming.",
        supporting_evidence: ["The requirement has measurable and subjective dimensions."],
        limitations: ["No single asset fully solves concision."],
        lifecycle_status: "suggested"
      }
    ]
  });
}

test("loads the deterministic catalog in stable order without changing its bytes", async () => {
  const before = await readFile(catalogIndex, "utf8");
  const catalog = await loadDeterministicAssetCatalog(catalogIndex);
  const after = await readFile(catalogIndex, "utf8");
  expect(after).toBe(before);
  expect(catalog.files).toEqual([...catalog.files].sort());
  expect(catalog.assets.length).toBeGreaterThan(0);
  for (const domain of ["language", "markdown", "javascript_typescript"]) {
    const assets = catalog.assets.filter((asset) => asset.domain === domain);
    const priorities = assets.map(({ priority }) => priority);
    expect(priorities).toEqual([...priorities].sort((left, right) => left - right));
  }
});

test("identifies the catalog path when JSON is malformed", async () => {
  const malformedIndexRoot = await mkdtemp(join(tmpdir(), "malformed-catalog-index-"));
  const malformedIndex = join(malformedIndexRoot, "catalog.json");
  await writeFile(malformedIndex, "{");
  await expect(loadDeterministicAssetCatalog(malformedIndex)).rejects.toThrow(malformedIndex);

  const malformedDomainRoot = await mkdtemp(join(tmpdir(), "malformed-catalog-domain-"));
  const indexPath = join(malformedDomainRoot, "catalog.json");
  await writeFile(
    indexPath,
    JSON.stringify({
      schema_version: "1.0.0",
      files: ["javascript-typescript.json", "language.json", "markdown.json"]
    })
  );
  await writeFile(join(malformedDomainRoot, "javascript-typescript.json"), "{");
  await writeFile(
    join(malformedDomainRoot, "language.json"),
    JSON.stringify({ schema_version: "1.0.0", domain: "language", assets: [] })
  );
  await writeFile(
    join(malformedDomainRoot, "markdown.json"),
    JSON.stringify({ schema_version: "1.0.0", domain: "markdown", assets: [] })
  );
  await expect(loadDeterministicAssetCatalog(indexPath)).rejects.toThrow("javascript-typescript.json");
});

test("rejects duplicate catalog asset IDs", () => {
  const asset = {
    id: "catalog_duplicate_asset",
    name: "Duplicate",
    domain: "language",
    asset_kind: "script",
    capability_level: "existing",
    priority: 1,
    capability_family: "Metrics",
    contribution: "Measures a property.",
    applicability: "Text.",
    evidence_basis: "A deterministic calculation.",
    limitations: ["Does not prove quality."]
  };
  expect(
    v.safeParse(CatalogDomainDocumentSchema, {
      schema_version: "1.0.0",
      domain: "language",
      assets: [asset, asset]
    }).success
  ).toBe(false);
});

test("rejects catalog files whose declared domain does not match their filename", async () => {
  const root = await mkdtemp(join(tmpdir(), "deterministic-catalog-"));
  const indexPath = join(root, "catalog.json");
  await writeFile(
    indexPath,
    JSON.stringify({
      schema_version: "1.0.0",
      files: ["javascript-typescript.json", "language.json", "markdown.json"]
    })
  );
  await writeFile(
    join(root, "javascript-typescript.json"),
    JSON.stringify({ schema_version: "1.0.0", domain: "javascript_typescript", assets: [] })
  );
  await writeFile(
    join(root, "language.json"),
    JSON.stringify({ schema_version: "1.0.0", domain: "markdown", assets: [] })
  );
  await writeFile(
    join(root, "markdown.json"),
    JSON.stringify({ schema_version: "1.0.0", domain: "markdown", assets: [] })
  );
  await expect(loadDeterministicAssetCatalog(indexPath)).rejects.toThrow(/must declare domain language/);
});

test("rejects catalog indexes that omit a supported domain file", () => {
  expect(
    v.safeParse(CatalogIndexSchema, {
      schema_version: "1.0.0",
      files: ["javascript-typescript.json", "language.json"]
    }).success
  ).toBe(false);
});

test("rejects unknown and relationship-mismatched catalog references", async () => {
  const catalog = await loadDeterministicAssetCatalog(catalogIndex);
  expect(() => validateCatalogReferences(documentWithCatalogReference("catalog_missing_asset"), catalog)).toThrow(
    /Unknown catalog asset/
  );
  const wrongRelationship = documentWithCatalogReference("catalog_languagetool_existing_families");
  wrongRelationship.opportunities[0].recommendations[0].catalog_asset_id = "catalog_languagetool_project_configuration";
  expect(() => validateCatalogReferences(wrongRelationship, catalog)).toThrow(/configurable, not existing/);
  expect(() => validateCatalogReferences(documentWithCatalogReference("catalog_text_metrics"), catalog)).not.toThrow();
});

test("LanguageTool catalog entries remain conditional and preserve editorial judgment", async () => {
  const catalog = await loadDeterministicAssetCatalog(catalogIndex);
  const entries = catalog.assets.filter(({ asset_kind }) => asset_kind === "languagetool");
  expect(entries.map(({ capability_level }) => capability_level)).toEqual(["existing", "configurable", "extensible"]);
  const wording = JSON.stringify(entries).toLowerCase();
  expect(wording).toContain("may contribute");
  expect(wording).toContain("does not imply");
  expect(wording).toContain("editorial");
  expect(wording).not.toMatch(/fully (?:solves|enforces) concision/);
});
