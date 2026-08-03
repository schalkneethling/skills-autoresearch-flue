import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { normalizeAnalysisResponse } from "./analyzer.js";
import { serializeCanonical, sha256 } from "./canonical.js";
import { loadDeterministicAssetCatalog } from "./catalog.js";
import { renderDeterminizationReport } from "./report.js";
import { renderResearchPrompt } from "./research-prompt.js";
import { createResearchRequest, serializeResearchRequest, type DerivativeLineage } from "./research-request.js";
import { withReadOnlyInputs } from "./read-only-snapshot.js";
import { canonicalAnalysisSha256, orderAnalysisOpportunities, serializeAnalysisOpportunities } from "./schemas.js";
import {
  assertSourceManifestCurrent,
  createSourceManifest,
  serializeSourceManifest,
  type AnalysisIdentity,
  type SourceManifest,
  type SourceSelection
} from "./source.js";

export interface DeterminizationArtifactPaths {
  root: string;
  source: string;
  opportunities: string;
  report: string;
  researchRequest: string;
  researchPrompt: string;
  transcript: string;
}

export interface WriteAnalysisArtifactsOptions {
  outputRoot: string;
  selections: SourceSelection[];
  catalogIndexPath: string;
  analysis?: AnalysisIdentity;
  analysisResponse: unknown;
  transcript?: { request: unknown; response: unknown };
}

const REQUIRED_CATALOG_PATHS = [
  "catalog.json",
  "javascript-typescript.json",
  "language.json",
  "markdown.json"
] as const;

function assertSelectedCatalogIndex(catalogIndexPath: string, selections: SourceSelection[]): void {
  const index = resolve(catalogIndexPath);
  const catalogSelections = selections.filter(({ namespace }) => namespace === "catalog");
  if (catalogSelections.length !== 1) {
    throw new Error("Exactly one complete catalog selection is required");
  }
  const selection = catalogSelections[0];
  if (resolve(selection.root, "catalog.json") !== index) {
    throw new Error("Catalog index must be catalog.json in the selected catalog root");
  }
  if (
    selection.paths.length !== REQUIRED_CATALOG_PATHS.length ||
    new Set(selection.paths).size !== selection.paths.length ||
    REQUIRED_CATALOG_PATHS.some((path) => !selection.paths.includes(path))
  ) {
    throw new Error(
      "Catalog selection must contain exactly catalog.json and every schema 1.0.0 domain file without duplicates"
    );
  }
}

export interface AnalysisArtifactResult {
  paths: DeterminizationArtifactPaths;
  opportunityCount: number;
  recommendationCount: number;
  sourceOpportunitiesSha256: string;
  resumedFiles: string[];
  createdFiles: string[];
}

function paths(outputRoot: string): DeterminizationArtifactPaths {
  const root = resolve(outputRoot);
  return {
    root,
    source: join(root, "source.json"),
    opportunities: join(root, "opportunities.json"),
    report: join(root, "report.md"),
    researchRequest: join(root, "research-request.json"),
    researchPrompt: join(root, "prompts", "research.md"),
    transcript: join(root, "transcript.json")
  };
}

async function projectedRealPath(path: string): Promise<string> {
  let cursor = resolve(path);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return join(await realpath(cursor), ...missingSegments.reverse());
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function assertOutputSeparate(outputRoot: string, selections: SourceSelection[]): Promise<void> {
  const output = await projectedRealPath(outputRoot);
  for (const selection of selections) {
    const root = await realpath(selection.root);
    const rel = relative(root, output);
    if (!rel || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))) {
      throw new Error(`Artifact output root must not be inside a selected read-only root: ${selection.namespace}`);
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function assertSafeDirectoryChain(outputRoot: string, parent: string, requireExisting: boolean): Promise<void> {
  const root = resolve(outputRoot);
  const targetParent = resolve(parent);
  const rel = relative(root, targetParent);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Artifact path escapes the caller-supplied output root: ${targetParent}`);
  }
  const components = [
    root,
    ...rel
      .split(sep)
      .filter(Boolean)
      .map((_, index, parts) => join(root, ...parts.slice(0, index + 1)))
  ];
  for (const component of components) {
    try {
      const metadata = await lstat(component);
      if (metadata.isSymbolicLink())
        throw new Error(`Artifact directory component must not be a symlink: ${component}`);
      if (!metadata.isDirectory()) throw new Error(`Artifact directory component must be a directory: ${component}`);
    } catch (error) {
      if (!requireExisting && isMissing(error)) return;
      throw error;
    }
  }
  const realRoot = await realpath(root);
  const realParent = await realpath(targetParent);
  const realRelative = relative(realRoot, realParent);
  if (realRelative === ".." || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
    throw new Error(`Artifact directory resolves outside the caller-supplied output root: ${targetParent}`);
  }
}

async function assertSafeArtifactFile(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`Artifact file must not be a symlink: ${path}`);
    if (!metadata.isFile()) throw new Error(`Artifact path must be a regular file: ${path}`);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}

function assertKnownSourceReferences(
  document: ReturnType<typeof orderAnalysisOpportunities>,
  manifest: SourceManifest
): void {
  const selected = new Set(manifest.inputs.map(({ path }) => path));
  for (const opportunity of document.opportunities) {
    for (const reference of opportunity.source_refs) {
      if (!selected.has(reference.path)) throw new Error(`Unknown selected source reference: ${reference.path}`);
    }
  }
}

async function ensureExactFile(outputRoot: string, path: string, contents: string): Promise<"created" | "resumed"> {
  const parent = dirname(path);
  await assertSafeDirectoryChain(outputRoot, parent, false);
  await mkdir(parent, { recursive: true });
  await assertSafeDirectoryChain(outputRoot, parent, true);
  await assertSafeArtifactFile(path);
  try {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
    return "created";
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    await assertSafeDirectoryChain(outputRoot, parent, true);
    await assertSafeArtifactFile(path);
    const existing = await readFile(path, "utf8");
    if (existing !== contents) {
      throw new Error(`Existing determinization artifact does not match canonical bytes: ${path}`, { cause: error });
    }
    return "resumed";
  }
}

function transcriptContents(lineage: DerivativeLineage, transcript: { request: unknown; response: unknown }): string {
  const jsonCompatible = JSON.parse(JSON.stringify(transcript)) as { request: unknown; response: unknown };
  return serializeCanonical({
    ...lineage,
    authority: "audit_only",
    request: jsonCompatible.request,
    response: jsonCompatible.response
  });
}

/** Writes only hash-linked Stage A artifacts and safely resumes only byte-identical files. */
export async function writeAnalysisArtifacts(options: WriteAnalysisArtifactsOptions): Promise<AnalysisArtifactResult> {
  assertSelectedCatalogIndex(options.catalogIndexPath, options.selections);
  await assertOutputSeparate(options.outputRoot, options.selections);
  return withReadOnlyInputs(options.selections, async () => {
    const artifactPaths = paths(options.outputRoot);
    const manifest = await createSourceManifest(options.selections, options.analysis);
    const catalog = await loadDeterministicAssetCatalog(options.catalogIndexPath);
    const analysis = orderAnalysisOpportunities(normalizeAnalysisResponse(options.analysisResponse, catalog));
    assertKnownSourceReferences(analysis, manifest);
    const opportunitiesContents = serializeAnalysisOpportunities(analysis);
    const opportunitiesHash = canonicalAnalysisSha256(analysis);
    if (sha256(opportunitiesContents) !== opportunitiesHash)
      throw new Error("Canonical opportunities byte hash mismatch");
    const lineage: DerivativeLineage = {
      schema_version: "1.0.0",
      source_opportunities_sha256: opportunitiesHash,
      opportunity_ids: analysis.opportunities.map(({ id }) => id)
    };
    const request = createResearchRequest(analysis, lineage);
    const planned: Array<[string, string]> = [
      [artifactPaths.source, serializeSourceManifest(manifest)],
      [artifactPaths.opportunities, opportunitiesContents],
      [artifactPaths.report, renderDeterminizationReport(analysis, lineage)],
      [artifactPaths.researchRequest, serializeResearchRequest(request)],
      [artifactPaths.researchPrompt, renderResearchPrompt(request)]
    ];
    if (options.transcript) planned.push([artifactPaths.transcript, transcriptContents(lineage, options.transcript)]);

    const createdFiles: string[] = [];
    const resumedFiles: string[] = [];
    for (const [path, contents] of planned) {
      await assertSourceManifestCurrent(manifest, options.selections);
      const disposition = await ensureExactFile(artifactPaths.root, path, contents);
      (disposition === "created" ? createdFiles : resumedFiles).push(path);
    }
    await assertSourceManifestCurrent(manifest, options.selections);
    return {
      paths: artifactPaths,
      opportunityCount: analysis.opportunities.length,
      recommendationCount: analysis.opportunities.reduce((count, item) => count + item.recommendations.length, 0),
      sourceOpportunitiesSha256: opportunitiesHash,
      resumedFiles,
      createdFiles
    };
  });
}
