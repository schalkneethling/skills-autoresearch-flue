import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { serializeCanonical, sha256 } from "./canonical.js";
import { DETERMINIZATION_SCHEMA_VERSION } from "./schemas.js";

export type SourceNamespace = "skill" | "evaluation" | "reference" | "context" | "catalog";

export interface SourceSelection {
  namespace: SourceNamespace;
  root: string;
  paths: string[];
}

export interface SourceManifestEntry {
  path: string;
  sha256: string;
}

export interface AnalysisIdentity {
  role: "determinizer";
  transport: string;
  model?: {
    provider?: string;
    name?: string;
  };
}

export interface SourceManifest {
  schema_version: typeof DETERMINIZATION_SCHEMA_VERSION;
  analysis?: AnalysisIdentity;
  inputs: SourceManifestEntry[];
}

const PORTABLE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u;

function normalizeAnalysisIdentity(identity: AnalysisIdentity | undefined): AnalysisIdentity | undefined {
  if (identity === undefined) return undefined;
  const unknownIdentityKeys = Object.keys(identity).filter((key) => !["role", "transport", "model"].includes(key));
  if (unknownIdentityKeys.length > 0) throw new Error("Source analysis identity contains unsupported metadata");
  if (identity.role !== "determinizer") throw new Error("Source analysis role must be determinizer");
  if (!PORTABLE_IDENTITY.test(identity.transport)) {
    throw new Error("Source analysis transport must be a portable nonblank identifier");
  }
  const model = identity.model;
  if (model !== undefined) {
    const unknownModelKeys = Object.keys(model).filter((key) => !["provider", "name"].includes(key));
    if (unknownModelKeys.length > 0) throw new Error("Source analysis model contains unsupported metadata");
    for (const [key, value] of Object.entries(model)) {
      if (value !== undefined && !PORTABLE_IDENTITY.test(value)) {
        throw new Error(`Source analysis model ${key} must be a portable nonblank identifier`);
      }
    }
    if (model.provider === undefined && model.name === undefined) {
      throw new Error("Source analysis model identity cannot be empty");
    }
  }
  return {
    role: "determinizer",
    transport: identity.transport,
    ...(model && {
      model: { ...(model.provider && { provider: model.provider }), ...(model.name && { name: model.name }) }
    })
  };
}

function portableRelativePath(path: string): string {
  if (!path || isAbsolute(path) || path.includes("\\"))
    throw new Error(`Expected a source-relative POSIX path: ${path}`);
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Expected a normalized source-relative POSIX path: ${path}`);
  }
  return path;
}

function resolveInside(root: string, portablePath: string): string {
  const rootPath = resolve(root);
  const target = resolve(rootPath, ...portableRelativePath(portablePath).split("/"));
  const rel = relative(rootPath, target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Selected path escapes or aliases its source root: ${portablePath}`);
  }
  return target;
}

export async function createSourceManifest(
  selections: SourceSelection[],
  analysis?: AnalysisIdentity
): Promise<SourceManifest> {
  const entries: SourceManifestEntry[] = [];
  const logicalPaths = new Set<string>();
  for (const selection of selections) {
    for (const sourcePath of selection.paths) {
      const portablePath = portableRelativePath(sourcePath);
      const logicalPath = `${selection.namespace}/${portablePath}`;
      if (logicalPaths.has(logicalPath)) throw new Error(`Duplicate selected source path: ${logicalPath}`);
      logicalPaths.add(logicalPath);
      const target = resolveInside(selection.root, portablePath);
      let cursor = resolve(selection.root);
      const rootMetadata = await lstat(cursor);
      if (rootMetadata.isSymbolicLink())
        throw new Error(`Symbolic links are not valid determinization inputs: ${logicalPath}`);
      let metadata = rootMetadata;
      for (const segment of portablePath.split("/")) {
        cursor = join(cursor, segment);
        metadata = await lstat(cursor);
        if (metadata.isSymbolicLink()) {
          throw new Error(`Symbolic links are not valid determinization inputs: ${logicalPath}`);
        }
      }
      if (!metadata.isFile()) throw new Error(`Only regular files are valid determinization inputs: ${logicalPath}`);
      entries.push({ path: logicalPath, sha256: sha256(await readFile(target)) });
    }
  }
  entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const normalizedAnalysis = normalizeAnalysisIdentity(analysis);
  return {
    schema_version: DETERMINIZATION_SCHEMA_VERSION,
    ...(normalizedAnalysis && { analysis: normalizedAnalysis }),
    inputs: entries
  };
}

export function serializeSourceManifest(manifest: SourceManifest): string {
  return serializeCanonical(manifest);
}

export async function assertSourceManifestCurrent(
  expected: SourceManifest,
  selections: SourceSelection[]
): Promise<void> {
  const actual = await createSourceManifest(selections, expected.analysis);
  if (serializeSourceManifest(actual) !== serializeSourceManifest(expected)) {
    throw new Error("Determinization inputs are stale: source or catalog fingerprints changed");
  }
}
