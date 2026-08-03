import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as v from "valibot";
import type { AnalysisOpportunitiesDocument } from "./schemas.js";
import { DeterministicAssetKindSchema, DeterminizationSchemaVersionSchema } from "./schemas.js";

const NonEmptyTextSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.check((value) => value.trim().length > 0, "Expected nonblank text")
);
const StableIdSchema = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u));
const PortableCatalogPathSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9][a-z0-9-]*\.json$/u, "Catalog domain files must be local JSON file names")
);

export const CatalogCapabilityLevelSchema = v.picklist(["existing", "configurable", "extensible"]);

export const CatalogAssetSchema = v.strictObject({
  id: StableIdSchema,
  name: NonEmptyTextSchema,
  domain: v.picklist(["language", "markdown", "javascript_typescript"]),
  asset_kind: DeterministicAssetKindSchema,
  capability_level: CatalogCapabilityLevelSchema,
  priority: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(3)),
  capability_family: NonEmptyTextSchema,
  contribution: NonEmptyTextSchema,
  applicability: NonEmptyTextSchema,
  evidence_basis: NonEmptyTextSchema,
  limitations: v.pipe(v.array(NonEmptyTextSchema), v.minLength(1))
});

export const CatalogDomainDocumentSchema = v.pipe(
  v.strictObject({
    schema_version: DeterminizationSchemaVersionSchema,
    domain: v.picklist(["language", "markdown", "javascript_typescript"]),
    assets: v.array(CatalogAssetSchema)
  }),
  v.check((document) => document.assets.every((asset) => asset.domain === document.domain), "Asset domain mismatch"),
  v.check((document) => {
    const ids = document.assets.map(({ id }) => id);
    return new Set(ids).size === ids.length;
  }, "Duplicate catalog asset IDs are not allowed"),
  v.check(
    (document) =>
      document.assets.every(
        (asset) => asset.priority === { existing: 1, configurable: 2, extensible: 3 }[asset.capability_level]
      ),
    "Catalog asset priority must match its capability level"
  )
);

export const CatalogIndexSchema = v.pipe(
  v.strictObject({
    schema_version: DeterminizationSchemaVersionSchema,
    files: v.pipe(v.array(PortableCatalogPathSchema), v.minLength(1))
  }),
  v.check((index) => new Set(index.files).size === index.files.length, "Duplicate catalog files are not allowed"),
  v.check(
    (index) =>
      index.files.length === 3 &&
      index.files[0] === "javascript-typescript.json" &&
      index.files[1] === "language.json" &&
      index.files[2] === "markdown.json",
    "Catalog index must contain exactly the three supported domain files in canonical order"
  )
);

export type CatalogAsset = v.InferOutput<typeof CatalogAssetSchema>;
export interface DeterministicAssetCatalog {
  schema_version: "1.0.0";
  assets: CatalogAsset[];
  files: string[];
}

function parse<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  schema: TSchema,
  value: unknown,
  label: string
): v.InferOutput<TSchema> {
  const result = v.safeParse(schema, value);
  if (!result.success) throw new Error(`Invalid ${label}: ${result.issues.map((issue) => issue.message).join("; ")}`);
  return result.output;
}

function isStrictlySorted(values: string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

function assetsFollowCatalogPriority(assets: CatalogAsset[]): boolean {
  return assets.every((asset, index) => {
    if (index === 0) return true;
    const previous = assets[index - 1];
    return previous.priority < asset.priority || (previous.priority === asset.priority && previous.id < asset.id);
  });
}

const EXPECTED_DOMAIN_BY_FILE: Record<string, CatalogAsset["domain"]> = {
  "javascript-typescript.json": "javascript_typescript",
  "language.json": "language",
  "markdown.json": "markdown"
};

/** Reads and validates the repository-owned catalog without ever opening files for writing. */
export async function loadDeterministicAssetCatalog(indexPath: string): Promise<DeterministicAssetCatalog> {
  const index = parse(CatalogIndexSchema, JSON.parse(await readFile(indexPath, "utf8")) as unknown, "catalog index");
  if (!isStrictlySorted(index.files)) throw new Error("Catalog files must be sorted by portable path");

  const documents = await Promise.all(
    index.files.map(async (file) => {
      const expectedDomain = EXPECTED_DOMAIN_BY_FILE[file];
      if (!expectedDomain) throw new Error(`Unsupported catalog domain file: ${file}`);
      const document = parse(
        CatalogDomainDocumentSchema,
        JSON.parse(await readFile(join(dirname(indexPath), file), "utf8")) as unknown,
        `catalog file ${file}`
      );
      if (document.domain !== expectedDomain) {
        throw new Error(`Catalog file ${file} must declare domain ${expectedDomain}, not ${document.domain}`);
      }
      return document;
    })
  );
  const domains = documents.map(({ domain }) => domain);
  if (new Set(domains).size !== domains.length) throw new Error("Duplicate catalog domain documents are not allowed");
  for (const document of documents) {
    if (!assetsFollowCatalogPriority(document.assets)) {
      throw new Error(`Catalog assets for ${document.domain} must follow capability priority, then ID`);
    }
  }
  const assets = documents.flatMap(({ assets }) => assets);
  const ids = assets.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate catalog asset IDs are not allowed across files");

  return { schema_version: index.schema_version, files: [...index.files], assets };
}

export function validateCatalogReferences(
  document: AnalysisOpportunitiesDocument,
  catalog: DeterministicAssetCatalog
): void {
  const assetsById = new Map(catalog.assets.map((asset) => [asset.id, asset]));
  for (const opportunity of document.opportunities) {
    for (const recommendation of opportunity.recommendations) {
      if (recommendation.catalog_asset_id) {
        const asset = assetsById.get(recommendation.catalog_asset_id);
        if (!asset) throw new Error(`Unknown catalog asset reference: ${recommendation.catalog_asset_id}`);
        if (asset.capability_level !== recommendation.relationship) {
          throw new Error(`Catalog asset ${asset.id} is ${asset.capability_level}, not ${recommendation.relationship}`);
        }
        if (asset.asset_kind !== recommendation.asset_kind) {
          throw new Error(`Catalog asset ${asset.id} has kind ${asset.asset_kind}, not ${recommendation.asset_kind}`);
        }
      }
      for (const assessment of recommendation.alternative_assessments) {
        const relationship = assessment.relationship;
        for (const id of assessment.catalog_asset_ids) {
          const asset = assetsById.get(id);
          if (!asset) throw new Error(`Unknown catalog asset reference: ${id}`);
          if (asset.capability_level !== relationship) {
            throw new Error(`Catalog alternative ${id} is ${asset.capability_level}, not ${relationship}`);
          }
        }
      }
    }
  }
}
