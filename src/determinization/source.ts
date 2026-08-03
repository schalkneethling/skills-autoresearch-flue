import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { compareCodePoints, serializeCanonical, sha256 } from "./canonical.js";
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
  request_sha256?: string;
  response_sha256?: string;
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
const SHA256 = /^[a-f0-9]{64}$/u;
export const MAX_DETERMINIZATION_SOURCE_FILE_BYTES = 256 * 1024;

function oversizedInputError(label: string): Error {
  return new Error(`Determinization input exceeds 256 KiB: ${label}`);
}

async function readBoundedHandle(handle: FileHandle, label: string): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(MAX_DETERMINIZATION_SOURCE_FILE_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_DETERMINIZATION_SOURCE_FILE_BYTES) throw oversizedInputError(label);
  const finalMetadata = await handle.stat();
  if (finalMetadata.size > MAX_DETERMINIZATION_SOURCE_FILE_BYTES) throw oversizedInputError(label);
  return buffer.subarray(0, offset);
}

export async function readBoundedDeterminizationFile(path: string, label: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Only regular files are valid determinization inputs: ${label}`);
  }
  if (metadata.size > MAX_DETERMINIZATION_SOURCE_FILE_BYTES) throw oversizedInputError(label);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const openedMetadata = await handle.stat();
    if (!openedMetadata.isFile() || openedMetadata.dev !== metadata.dev || openedMetadata.ino !== metadata.ino) {
      throw new Error(`Source input changed during determinization: ${label}`);
    }
    if (openedMetadata.size > MAX_DETERMINIZATION_SOURCE_FILE_BYTES) throw oversizedInputError(label);
    return await readBoundedHandle(handle, label);
  } finally {
    await handle.close();
  }
}

function normalizeAnalysisIdentity(identity: AnalysisIdentity | undefined): AnalysisIdentity | undefined {
  if (identity === undefined) return undefined;
  if (identity === null || typeof identity !== "object" || Array.isArray(identity)) {
    throw new Error("Source analysis identity must be an object");
  }
  const unknownIdentityKeys = Object.keys(identity).filter(
    (key) => !["role", "transport", "request_sha256", "response_sha256", "model"].includes(key)
  );
  if (unknownIdentityKeys.length > 0) throw new Error("Source analysis identity contains unsupported metadata");
  if (identity.role !== "determinizer") throw new Error("Source analysis role must be determinizer");
  if (typeof identity.transport !== "string" || !PORTABLE_IDENTITY.test(identity.transport)) {
    throw new Error("Source analysis transport must be a portable nonblank identifier");
  }
  if ((identity.request_sha256 === undefined) !== (identity.response_sha256 === undefined)) {
    throw new Error("Source analysis request and response hashes must be provided together");
  }
  if (
    (identity.request_sha256 !== undefined &&
      (typeof identity.request_sha256 !== "string" || !SHA256.test(identity.request_sha256))) ||
    (identity.response_sha256 !== undefined &&
      (typeof identity.response_sha256 !== "string" || !SHA256.test(identity.response_sha256)))
  ) {
    throw new Error("Source analysis request and response hashes must be strict SHA-256 values");
  }
  const model = identity.model;
  if (model !== undefined) {
    if (model === null || typeof model !== "object" || Array.isArray(model)) {
      throw new Error("Source analysis model must be an object");
    }
    const unknownModelKeys = Object.keys(model).filter((key) => !["provider", "name"].includes(key));
    if (unknownModelKeys.length > 0) throw new Error("Source analysis model contains unsupported metadata");
    for (const [key, value] of Object.entries(model)) {
      if (value !== undefined && (typeof value !== "string" || !PORTABLE_IDENTITY.test(value))) {
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
    ...(identity.request_sha256 && { request_sha256: identity.request_sha256 }),
    ...(identity.response_sha256 && { response_sha256: identity.response_sha256 }),
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
      const rawPortablePath = portableRelativePath(sourcePath);
      const portablePath = rawPortablePath.normalize("NFC");
      const logicalPath = `${selection.namespace}/${portablePath}`;
      if (logicalPaths.has(logicalPath)) throw new Error(`Duplicate selected source path: ${logicalPath}`);
      logicalPaths.add(logicalPath);
      const target = resolveInside(selection.root, rawPortablePath);
      let cursor = resolve(selection.root);
      const rootMetadata = await lstat(cursor);
      if (rootMetadata.isSymbolicLink())
        throw new Error(`Symbolic links are not valid determinization inputs: ${logicalPath}`);
      let metadata = rootMetadata;
      for (const segment of rawPortablePath.split("/")) {
        cursor = join(cursor, segment);
        metadata = await lstat(cursor);
        if (metadata.isSymbolicLink()) {
          throw new Error(`Symbolic links are not valid determinization inputs: ${logicalPath}`);
        }
      }
      if (!metadata.isFile()) throw new Error(`Only regular files are valid determinization inputs: ${logicalPath}`);
      if (metadata.size > MAX_DETERMINIZATION_SOURCE_FILE_BYTES) {
        throw oversizedInputError(logicalPath);
      }
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const openedMetadata = await handle.stat();
        if (!openedMetadata.isFile() || openedMetadata.dev !== metadata.dev || openedMetadata.ino !== metadata.ino) {
          throw new Error(`Source input changed during determinization: ${logicalPath}`);
        }
        if (openedMetadata.size > MAX_DETERMINIZATION_SOURCE_FILE_BYTES) {
          throw oversizedInputError(logicalPath);
        }
        entries.push({ path: logicalPath, sha256: sha256(await readBoundedHandle(handle, logicalPath)) });
      } finally {
        await handle.close();
      }
    }
  }
  entries.sort((left, right) => compareCodePoints(left.path, right.path));
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
