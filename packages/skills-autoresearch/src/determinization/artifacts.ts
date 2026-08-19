import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as v from "valibot";
import { normalizeAnalysisResponse } from "./analyzer.js";
import { serializeCanonical, sha256 } from "./canonical.js";
import { loadDeterministicAssetCatalog } from "./catalog.js";
import { renderDeterminizationReport } from "./report.js";
import { renderResearchPrompt } from "./research-prompt.js";
import { createResearchRequest, serializeResearchRequest, type DerivativeLineage } from "./research-request.js";
import { withReadOnlyInputs } from "./read-only-snapshot.js";
import {
  DETERMINIZATION_SCHEMA_VERSION,
  canonicalAnalysisSha256,
  orderAnalysisOpportunities,
  serializeAnalysisOpportunities
} from "./schemas.js";
import { validateCanonicalAnalysis } from "./validation.js";
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
  expectedAnalysisRequest?: unknown;
  transcript?: { request: unknown; response: unknown };
}

export interface ResumeAnalysisArtifactsOptions {
  outputRoot: string;
  selections: SourceSelection[];
  catalogIndexPath: string;
  expectedModel?: { provider: string; name: string };
  expectedAnalysisRequest: unknown;
}

const REQUIRED_CATALOG_PATHS = [
  "catalog.json",
  "javascript-typescript.json",
  "language.json",
  "markdown.json"
] as const;

const Sha256Schema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/u));
const RequiredUnknownSchema = v.pipe(
  v.unknown(),
  v.check((value) => value !== undefined, "Expected a required transcript value")
);
const AnalysisTranscriptSchema = v.strictObject({
  schema_version: v.literal(DETERMINIZATION_SCHEMA_VERSION),
  source_opportunities_sha256: Sha256Schema,
  opportunity_ids: v.array(v.pipe(v.string(), v.regex(/^opp_[a-f0-9]{20}$/u))),
  authority: v.literal("audit_only"),
  source_manifest_sha256: Sha256Schema,
  request_sha256: Sha256Schema,
  response_sha256: Sha256Schema,
  request: RequiredUnknownSchema,
  response: RequiredUnknownSchema
});

type AnalysisTranscript = v.InferOutput<typeof AnalysisTranscriptSchema>;

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

/** Read-only preflight for callers that must reject unsafe output placement before invoking a transport. */
export async function assertAnalysisArtifactBoundary(outputRoot: string, selections: SourceSelection[]): Promise<void> {
  await assertOutputSeparate(outputRoot, selections);
  let cursor = resolve(outputRoot);
  for (;;) {
    try {
      const metadata = await lstat(cursor);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Artifact output root or nearest existing parent must not be a symlink: ${cursor}`);
      }
      if (!metadata.isDirectory()) throw new Error(`Artifact output root parent must be a directory: ${cursor}`);
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
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

function transcriptContents(
  lineage: DerivativeLineage,
  transcript: { request: unknown; response: unknown },
  manifest: SourceManifest,
  analysisResponse: unknown,
  expectedAnalysisRequest: unknown
): string {
  const jsonCompatible = JSON.parse(JSON.stringify(transcript)) as { request: unknown; response: unknown };
  const response = JSON.parse(JSON.stringify(analysisResponse)) as unknown;
  const expectedRequest = JSON.parse(JSON.stringify(expectedAnalysisRequest)) as unknown;
  if (serializeCanonical(jsonCompatible.request) !== serializeCanonical(expectedRequest)) {
    throw new Error("Determinization transcript request does not match the expected analysis request");
  }
  assertTranscriptRequestIdentity({ request: jsonCompatible.request }, manifest);
  if (serializeCanonical(jsonCompatible.response) !== serializeCanonical(response)) {
    throw new Error("Determinization transcript response does not match the analyzed response");
  }
  const requestBytes = serializeCanonical(jsonCompatible.request);
  const responseBytes = serializeCanonical(jsonCompatible.response);
  return serializeCanonical({
    ...lineage,
    authority: "audit_only",
    source_manifest_sha256: sha256(serializeSourceManifest(manifest)),
    request_sha256: sha256(requestBytes),
    response_sha256: sha256(responseBytes),
    request: jsonCompatible.request,
    response: jsonCompatible.response
  });
}

function analysisIdentityWithRawHashes(options: WriteAnalysisArtifactsOptions): AnalysisIdentity | undefined {
  if (!options.transcript) return options.analysis;
  if (options.expectedAnalysisRequest === undefined) {
    throw new Error("An independently constructed expected analysis request is required with a transcript");
  }
  if (!options.analysis) {
    throw new Error("A source analysis identity is required with a transcript");
  }
  const request = JSON.parse(JSON.stringify(options.expectedAnalysisRequest)) as unknown;
  const response = JSON.parse(JSON.stringify(options.analysisResponse)) as unknown;
  return {
    ...options.analysis,
    request_sha256: sha256(serializeCanonical(request)),
    response_sha256: sha256(serializeCanonical(response))
  };
}

function parseAnalysisTranscript(value: unknown): AnalysisTranscript {
  const result = v.safeParse(AnalysisTranscriptSchema, value);
  if (!result.success) throw new Error("Cannot resume determinization: transcript shape is invalid");
  return result.output;
}

function assertTranscriptRequestIdentity(
  transcript: Pick<AnalysisTranscript, "request">,
  manifest: SourceManifest
): void {
  const request = transcript.request;
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Cannot resume determinization: transcript request identity is invalid");
  }
  const model = (request as Record<string, unknown>).model;
  if (model === null || typeof model !== "object" || Array.isArray(model)) {
    throw new Error("Cannot resume determinization: transcript request model identity is missing");
  }
  const sourceModel = manifest.analysis?.model;
  const requestModel = model as Record<string, unknown>;
  if (
    sourceModel?.provider === undefined ||
    sourceModel.name === undefined ||
    requestModel.provider !== sourceModel.provider ||
    requestModel.name !== sourceModel.name
  ) {
    throw new Error("Cannot resume determinization: transcript request does not match source model identity");
  }
}

function derivativePlan(
  artifactPaths: DeterminizationArtifactPaths,
  analysis: ReturnType<typeof orderAnalysisOpportunities>,
  lineage: DerivativeLineage
): Array<[string, string]> {
  const request = createResearchRequest(analysis, lineage);
  return [
    [artifactPaths.report, renderDeterminizationReport(analysis, lineage)],
    [artifactPaths.researchRequest, serializeResearchRequest(request)],
    [artifactPaths.researchPrompt, renderResearchPrompt(request)]
  ];
}

async function persistPlan(
  artifactPaths: DeterminizationArtifactPaths,
  manifest: SourceManifest,
  selections: SourceSelection[],
  planned: Array<[string, string]>
): Promise<{ createdFiles: string[]; resumedFiles: string[] }> {
  const createdFiles: string[] = [];
  const resumedFiles: string[] = [];
  for (const [path, contents] of planned) {
    await assertSourceManifestCurrent(manifest, selections);
    const disposition = await ensureExactFile(artifactPaths.root, path, contents);
    (disposition === "created" ? createdFiles : resumedFiles).push(path);
  }
  await assertSourceManifestCurrent(manifest, selections);
  return { createdFiles, resumedFiles };
}

/** Writes only hash-linked Stage A artifacts and safely resumes only byte-identical files. */
export async function writeAnalysisArtifacts(options: WriteAnalysisArtifactsOptions): Promise<AnalysisArtifactResult> {
  assertSelectedCatalogIndex(options.catalogIndexPath, options.selections);
  await assertOutputSeparate(options.outputRoot, options.selections);
  return withReadOnlyInputs(options.selections, async () => {
    const artifactPaths = paths(options.outputRoot);
    const manifest = await createSourceManifest(options.selections, analysisIdentityWithRawHashes(options));
    const catalog = await loadDeterministicAssetCatalog(options.catalogIndexPath);
    const analysis = orderAnalysisOpportunities(normalizeAnalysisResponse(options.analysisResponse, catalog));
    assertKnownSourceReferences(analysis, manifest);
    const opportunitiesContents = serializeAnalysisOpportunities(analysis);
    const opportunitiesHash = canonicalAnalysisSha256(analysis);
    if (sha256(opportunitiesContents) !== opportunitiesHash)
      throw new Error("Canonical opportunities byte hash mismatch");
    const lineage: DerivativeLineage = {
      schema_version: DETERMINIZATION_SCHEMA_VERSION,
      source_opportunities_sha256: opportunitiesHash,
      opportunity_ids: analysis.opportunities.map(({ id }) => id)
    };
    const planned: Array<[string, string]> = [
      [artifactPaths.source, serializeSourceManifest(manifest)],
      [artifactPaths.opportunities, opportunitiesContents],
      ...derivativePlan(artifactPaths, analysis, lineage)
    ];
    if (options.transcript) {
      planned.push([
        artifactPaths.transcript,
        transcriptContents(
          lineage,
          options.transcript,
          manifest,
          options.analysisResponse,
          options.expectedAnalysisRequest
        )
      ]);
    }
    const { createdFiles, resumedFiles } = await persistPlan(artifactPaths, manifest, options.selections, planned);
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

/** Reuses immutable canonical analysis without making another model call. */
export async function resumeAnalysisArtifacts(
  options: ResumeAnalysisArtifactsOptions
): Promise<AnalysisArtifactResult> {
  assertSelectedCatalogIndex(options.catalogIndexPath, options.selections);
  await assertOutputSeparate(options.outputRoot, options.selections);
  return withReadOnlyInputs(options.selections, async () => {
    const artifactPaths = paths(options.outputRoot);
    const existingSource = await readFile(artifactPaths.source, "utf8");
    const recordedSource = JSON.parse(existingSource) as { analysis?: AnalysisIdentity };
    if (
      options.expectedModel &&
      (recordedSource.analysis?.model?.provider !== options.expectedModel.provider ||
        recordedSource.analysis.model.name !== options.expectedModel.name)
    ) {
      throw new Error("Cannot resume determinization: configured determinizer model changed");
    }
    const manifest = await createSourceManifest(options.selections, recordedSource.analysis);
    if (existingSource !== serializeSourceManifest(manifest)) {
      throw new Error("Cannot resume determinization: source or catalog manifest is stale");
    }
    const catalog = await loadDeterministicAssetCatalog(options.catalogIndexPath);
    const opportunitiesBytes = await readFile(artifactPaths.opportunities, "utf8");
    const analysis = orderAnalysisOpportunities(
      validateCanonicalAnalysis(JSON.parse(opportunitiesBytes) as unknown, catalog)
    );
    if (serializeAnalysisOpportunities(analysis) !== opportunitiesBytes) {
      throw new Error("Cannot resume determinization: opportunities.json is not canonical or was modified");
    }
    assertKnownSourceReferences(analysis, manifest);
    const opportunitiesHash = canonicalAnalysisSha256(analysis);
    const lineage: DerivativeLineage = {
      schema_version: DETERMINIZATION_SCHEMA_VERSION,
      source_opportunities_sha256: opportunitiesHash,
      opportunity_ids: analysis.opportunities.map(({ id }) => id)
    };
    const transcriptBytes = await readFile(artifactPaths.transcript, "utf8");
    const transcript = parseAnalysisTranscript(JSON.parse(transcriptBytes) as unknown);
    const expectedRequest = JSON.parse(JSON.stringify(options.expectedAnalysisRequest)) as unknown;
    if (
      transcript.schema_version !== DETERMINIZATION_SCHEMA_VERSION ||
      transcript.authority !== "audit_only" ||
      transcript.source_manifest_sha256 !== sha256(existingSource) ||
      transcript.source_opportunities_sha256 !== opportunitiesHash ||
      JSON.stringify(transcript.opportunity_ids) !== JSON.stringify(lineage.opportunity_ids) ||
      transcript.request_sha256 !== manifest.analysis?.request_sha256 ||
      transcript.request_sha256 !== sha256(serializeCanonical(expectedRequest)) ||
      serializeCanonical(transcript.request) !== serializeCanonical(expectedRequest) ||
      transcript.response_sha256 !== manifest.analysis?.response_sha256 ||
      transcript.response_sha256 !== sha256(serializeCanonical(transcript.response)) ||
      serializeCanonical(transcript) !== transcriptBytes
    ) {
      throw new Error("Cannot resume determinization: transcript provenance is missing, stale, or non-canonical");
    }
    assertTranscriptRequestIdentity(transcript, manifest);
    const transcriptAnalysis = orderAnalysisOpportunities(normalizeAnalysisResponse(transcript.response, catalog));
    if (serializeAnalysisOpportunities(transcriptAnalysis) !== opportunitiesBytes) {
      throw new Error("Cannot resume determinization: transcript response does not match canonical opportunities");
    }
    const planned: Array<[string, string]> = [
      [artifactPaths.source, existingSource],
      [artifactPaths.opportunities, opportunitiesBytes],
      ...derivativePlan(artifactPaths, analysis, lineage)
    ];
    const { createdFiles, resumedFiles } = await persistPlan(artifactPaths, manifest, options.selections, planned);
    return {
      paths: artifactPaths,
      opportunityCount: analysis.opportunities.length,
      recommendationCount: analysis.opportunities.reduce((count, item) => count + item.recommendations.length, 0),
      sourceOpportunitiesSha256: opportunitiesHash,
      createdFiles,
      resumedFiles
    };
  });
}
