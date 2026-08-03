import { dirname, join } from "node:path";
import * as v from "valibot";
import type { AnalysisOpportunitiesDocument } from "./schemas.js";
import {
  DeterministicAssetKindSchema,
  DeterminizationSchemaVersionSchema,
  NonEmptyTextSchema,
  StableIdSchema
} from "./schemas.js";
import { readBoundedDeterminizationFile } from "./source.js";

export const CATALOG_DOMAIN_FILES = {
  javascript_typescript: "javascript-typescript.json",
  language: "language.json",
  markdown: "markdown.json"
} as const;
type CatalogDomain = keyof typeof CATALOG_DOMAIN_FILES;
const CATALOG_DOMAINS = Object.keys(CATALOG_DOMAIN_FILES) as [CatalogDomain, ...CatalogDomain[]];
const CATALOG_FILES = Object.values(CATALOG_DOMAIN_FILES);
const DOMAIN_BY_CATALOG_FILE = Object.fromEntries(
  Object.entries(CATALOG_DOMAIN_FILES).map(([domain, file]) => [file, domain])
) as Record<string, CatalogDomain>;

export const CatalogDomainSchema = v.picklist(CATALOG_DOMAINS);
const PortableCatalogPathSchema = v.pipe(
  v.string(),
  v.regex(/^[a-z0-9][a-z0-9-]*\.json$/u, "Catalog domain files must be local JSON file names")
);

export const CatalogCapabilityLevelSchema = v.picklist(["existing", "configurable", "extensible"]);

export const CatalogAssetSchema = v.strictObject({
  id: StableIdSchema,
  name: NonEmptyTextSchema,
  domain: CatalogDomainSchema,
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
    domain: CatalogDomainSchema,
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
      index.files.length === CATALOG_FILES.length &&
      index.files.every((file, indexPosition) => file === CATALOG_FILES[indexPosition]),
    "Catalog index must contain exactly the supported domain files in canonical order"
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

function assetsFollowCatalogPriority(assets: CatalogAsset[]): boolean {
  return assets.every((asset, index) => {
    if (index === 0) return true;
    const previous = assets[index - 1];
    return previous.priority < asset.priority || (previous.priority === asset.priority && previous.id < asset.id);
  });
}

async function readJson(path: string, label: string): Promise<unknown> {
  const contents = (await readBoundedDeterminizationFile(path, `${label}: ${path}`)).toString("utf8");
  try {
    return JSON.parse(contents) as unknown;
  } catch (cause) {
    throw new Error(`Invalid JSON in ${label}: ${path}`, { cause });
  }
}

/** Reads and validates the repository-owned catalog without ever opening files for writing. */
export async function loadDeterministicAssetCatalog(indexPath: string): Promise<DeterministicAssetCatalog> {
  const index = parse(CatalogIndexSchema, await readJson(indexPath, "catalog index"), "catalog index");

  const documents = await Promise.all(
    index.files.map(async (file) => {
      const expectedDomain = DOMAIN_BY_CATALOG_FILE[file];
      if (!expectedDomain) throw new Error(`Unsupported catalog domain file: ${file}`);
      const document = parse(
        CatalogDomainDocumentSchema,
        await readJson(join(dirname(indexPath), file), `catalog file ${file}`),
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
