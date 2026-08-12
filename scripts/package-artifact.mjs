import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { basename, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, URL } from "node:url";

export const PACKAGE_NAME = "@schalkneethling/skills-autoresearch";
export const PACKAGE_DIRECTORY = "packages/skills-autoresearch";
export const PACKED_MANIFEST_PATH = "package/package.json";
export const CLEAN_ROOM_PROOF_REQUIREMENTS = Object.freeze({
  offlineInstall: true,
  ignoreScripts: true,
  smoke: Object.freeze({ score: 0.6, modelCalls: 0 }),
  determinization: Object.freeze({
    opportunities: 1,
    recommendations: 3,
    modelCalls: 0,
    artifactCount: 6
  })
});

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_ARCHIVE_PREFIX = "schalkneethling-skills-autoresearch-";
const PACKAGE_MANIFEST_MAX_BYTES = 256 * 1024;
const TAR_LIST_MAX_BYTES = 8 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const REQUIRED_FILES = ["CHANGELOG.md", "LICENSE", "README.md", "package.json"];
const RECURSIVE_FILE_ROOTS = ["catalog/deterministic-assets", "dist"];
const EXPECTED_REPOSITORY = Object.freeze({
  type: "git",
  url: "git+ssh://git@github.com/schalkneethling/skills-autoresearch-flue.git",
  directory: PACKAGE_DIRECTORY
});
const EXPECTED_PUBLISH_CONFIG = Object.freeze({ access: "public", provenance: true });
const EXPECTED_BIN = Object.freeze({
  "skills-autoresearch": "./dist/bin/skills-autoresearch.js",
  "skills-autoresearch-flue": "./dist/bin/skills-autoresearch-flue.js"
});
const EXPECTED_DEPENDENCIES = Object.freeze({
  "@flue/runtime": "2.0.3",
  valibot: "^1.4.2"
});
const EXPECTED_FILE_ALLOWLIST = Object.freeze([
  "dist",
  "catalog/deterministic-assets",
  "README.md",
  "CHANGELOG.md",
  "LICENSE"
]);

function fail(message) {
  throw new Error(message);
}

function assertDeepEqual(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    fail(`${label} does not match the package contract.`);
  }
}

function compareCodePoints(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function assertVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`Package version ${JSON.stringify(version)} is not a supported semantic version.`);
  }
}

export function canonicalArchiveName(version) {
  assertVersion(version);
  return `${PACKAGE_ARCHIVE_PREFIX}${version}.tgz`;
}

export function validateSourceManifest(manifest) {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("Source package manifest must be a JSON object.");
  }
  if (manifest.name !== PACKAGE_NAME) fail(`Source package name must be ${PACKAGE_NAME}.`);
  assertVersion(manifest.version);
  if (manifest.private === true) fail("The publishable package must not be private.");
  if (manifest.type !== "module") fail("The publishable package must remain ESM.");
  if (manifest.license !== "MIT") fail("Source package license must be MIT.");
  assertDeepEqual(manifest.repository, EXPECTED_REPOSITORY, "Source package repository");
  assertDeepEqual(manifest.publishConfig, EXPECTED_PUBLISH_CONFIG, "Source package publishConfig");
  assertDeepEqual(manifest.bin, EXPECTED_BIN, "Source package binaries");
  assertDeepEqual(manifest.dependencies, EXPECTED_DEPENDENCIES, "Source package dependencies");
  assertDeepEqual(manifest.files, EXPECTED_FILE_ALLOWLIST, "Source package file allowlist");
  assertDeepEqual(manifest.exports, {}, "Source package exports");
  if (!isDeepStrictEqual(manifest.engines, { node: ">=24" })) {
    fail("Source package Node engine must be >=24.");
  }
  return manifest;
}

function candidateDescription(candidates) {
  return candidates.map(({ name, type }) => `${name} (${type})`).join(", ") || "none";
}

export function validateArchiveCandidates(candidates, expectedName, mode) {
  if (mode !== "before-pack" && mode !== "after-pack") {
    fail(`Unknown archive validation mode: ${mode}.`);
  }
  if (!Array.isArray(candidates)) fail("Archive candidates must be an array.");

  const unexpected = candidates.filter(({ name }) => name !== expectedName);
  if (unexpected.length > 0) {
    fail(`Unexpected archive(s) in packages/: ${candidateDescription(unexpected)}. Expected only ${expectedName}.`);
  }
  if (candidates.length > 1) {
    fail(`Expected exactly one ${expectedName} archive, found ${candidates.length}.`);
  }
  if (candidates.length === 0) {
    if (mode === "before-pack") return null;
    fail(`The authoritative archive ${expectedName} is missing.`);
  }

  const [candidate] = candidates;
  if (candidate.type !== "file") {
    fail(`The authoritative archive ${expectedName} must be a regular file, not ${candidate.type}.`);
  }
  return candidate;
}

function toPortablePath(path) {
  return path.split(sep).join("/");
}

function sortedUniqueFiles(files, label) {
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) {
    fail(`${label} must be an array of file paths.`);
  }
  const sorted = [...files].sort(compareCodePoints);
  if (new Set(sorted).size !== sorted.length) fail(`${label} contains duplicate paths.`);
  return sorted;
}

function isAllowlistedArchiveFile(file) {
  return (
    REQUIRED_FILES.some((required) => file === `package/${required}`) ||
    file.startsWith("package/dist/") ||
    file.startsWith("package/catalog/deterministic-assets/")
  );
}

function validateArchivePath(file) {
  if (
    file.includes("\\") ||
    file.startsWith("/") ||
    file.endsWith("/") ||
    file.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    fail(`Archive entry ${JSON.stringify(file)} is not a safe portable file path.`);
  }
  if (!isAllowlistedArchiveFile(file)) {
    fail(`Archive entry ${JSON.stringify(file)} is not allowlisted.`);
  }
}

export function validatePackedContract({ sourceManifest, packedManifest, archiveFiles, expectedFiles }) {
  validateSourceManifest(sourceManifest);
  if (packedManifest === null || typeof packedManifest !== "object" || Array.isArray(packedManifest)) {
    fail("Packed package manifest must be a JSON object.");
  }

  for (const field of ["name", "version", "repository", "license", "publishConfig", "bin", "dependencies"]) {
    assertDeepEqual(packedManifest[field], sourceManifest[field], `Packed manifest ${field}`);
  }
  if (packedManifest.private === true) fail("Packed package manifest must not be private.");

  const actual = sortedUniqueFiles(archiveFiles, "Archive inventory");
  const expected = sortedUniqueFiles(expectedFiles, "Expected archive inventory");
  actual.forEach(validateArchivePath);

  if (!isDeepStrictEqual(actual, expected)) {
    const missing = expected.filter((file) => !actual.includes(file));
    const extra = actual.filter((file) => !expected.includes(file));
    fail(
      `Packed inventory does not match the package allowlist. Missing: ${missing.join(", ") || "none"}. Extra: ${extra.join(", ") || "none"}.`
    );
  }

  for (const target of Object.values(EXPECTED_BIN)) {
    const packedTarget = `package/${target.replace(/^\.\//, "")}`;
    if (!actual.includes(packedTarget)) fail(`Packed binary target ${packedTarget} is missing.`);
  }

  return { fileCount: actual.length, files: actual };
}

function isMissingFileError(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readBoundedText(path, maximumBytes, label) {
  const before = await lstat(path);
  if (!before.isFile()) fail(`${label} must be a regular file: ${path}`);
  if (before.size > maximumBytes) {
    fail(`${label} exceeds the ${maximumBytes}-byte limit: ${path}`);
  }
  const contents = await readFile(path, "utf8");
  if (Buffer.byteLength(contents, "utf8") > maximumBytes) {
    fail(`${label} exceeds the ${maximumBytes}-byte limit after reading: ${path}`);
  }
  return contents;
}

async function readJson(path, label) {
  const contents = await readBoundedText(path, PACKAGE_MANIFEST_MAX_BYTES, label);
  try {
    return JSON.parse(contents);
  } catch (error) {
    fail(`${label} contains malformed JSON at ${path}: ${error.message}`);
  }
}

async function collectRegularFiles(root, current = root) {
  const rootStats = await lstat(current);
  if (!rootStats.isDirectory()) fail(`Expected package directory: ${current}`);

  const files = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => compareCodePoints(left.name, right.name));
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) fail(`Package inventory must not contain symlinks: ${absolute}`);
    if (stats.isDirectory()) {
      files.push(...(await collectRegularFiles(root, absolute)));
    } else if (stats.isFile()) {
      files.push(toPortablePath(relative(root, absolute)));
    } else {
      fail(`Package inventory contains a non-regular entry: ${absolute}`);
    }
  }
  return files;
}

export async function cleanPackageBuildOutput(packageRoot) {
  const resolvedPackageRoot = resolve(packageRoot);
  const packageStats = await lstat(resolvedPackageRoot);
  if (!packageStats.isDirectory() || packageStats.isSymbolicLink()) {
    fail(`Package root must be a regular directory: ${resolvedPackageRoot}`);
  }
  const canonicalPackageRoot = await realpath(resolvedPackageRoot);
  if (canonicalPackageRoot !== resolvedPackageRoot) {
    fail(`Package root must not traverse symlinks: ${resolvedPackageRoot}`);
  }

  const distPath = resolve(resolvedPackageRoot, "dist");
  if (relative(resolvedPackageRoot, distPath) !== "dist") {
    fail(`Refusing to clean unresolved package output: ${distPath}`);
  }

  let distStats;
  try {
    distStats = await lstat(distPath);
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
  if (!distStats.isDirectory() || distStats.isSymbolicLink()) {
    fail(`Package build output must be a regular directory: ${distPath}`);
  }
  const canonicalDistPath = await realpath(distPath);
  if (canonicalDistPath !== distPath || relative(canonicalPackageRoot, canonicalDistPath) !== "dist") {
    fail(`Package build output must be a direct, non-symlinked descendant: ${distPath}`);
  }

  await collectRegularFiles(distPath);
  await rm(distPath, { recursive: true, force: false });
  try {
    await lstat(distPath);
    fail(`Package build output still exists after cleanup: ${distPath}`);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  return true;
}

async function expectedArchiveFiles(packageRoot) {
  const expected = [];
  for (const required of REQUIRED_FILES) {
    const absolute = join(packageRoot, required);
    const stats = await lstat(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      fail(`Required package file must be regular: ${absolute}`);
    }
    expected.push(`package/${required}`);
  }
  for (const directory of RECURSIVE_FILE_ROOTS) {
    const absolute = join(packageRoot, directory);
    const files = await collectRegularFiles(absolute);
    if (files.length === 0) fail(`Required package directory is empty: ${absolute}`);
    for (const file of files) expected.push(`package/${directory}/${file}`);
  }
  return sortedUniqueFiles(expected, "Expected archive inventory");
}

function directoryEntryType(stats) {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isFile()) return "file";
  if (stats.isDirectory()) return "directory";
  return "other";
}

async function scanArchiveDirectory(archiveDirectory) {
  const entries = await readdir(archiveDirectory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".tgz")) continue;
    const stats = await lstat(join(archiveDirectory, entry.name));
    candidates.push({ name: entry.name, type: directoryEntryType(stats) });
  }
  return candidates.sort((left, right) => compareCodePoints(left.name, right.name));
}

async function runCommand(
  command,
  args,
  { cwd, env = process.env, maximumStdoutBytes = 1024 * 1024, timeoutMs = COMMAND_TIMEOUT_MS } = {}
) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = null;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maximumStdoutBytes) {
        overflow = `${command} stdout exceeded ${maximumStdoutBytes} bytes.`;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > maximumStdoutBytes) {
        overflow = `${command} stderr exceeded ${maximumStdoutBytes} bytes.`;
        child.kill("SIGKILL");
        return;
      }
      stderr.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (overflow !== null) return rejectPromise(new Error(overflow));
      if (timedOut) {
        return rejectPromise(new Error(`${command} timed out after ${timeoutMs} milliseconds.`));
      }
      if (code !== 0) {
        return rejectPromise(
          new Error(
            `${command} ${args.join(" ")} failed (${signal ?? `exit ${code}`}): ${errorOutput.trim() || output.trim() || "no output"}`
          )
        );
      }
      resolvePromise({ stdout: output, stderr: errorOutput });
    });
  });
}

async function sha256File(path, expectedSize) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await lstat(path);
  if (!after.isFile() || after.size !== expectedSize) {
    fail(`Archive changed while hashing: ${path}`);
  }
  return hash.digest("hex");
}

async function loadSourcePackageContract(repositoryRoot) {
  const packageRoot = resolve(repositoryRoot, PACKAGE_DIRECTORY);
  const archiveDirectory = resolve(repositoryRoot, "packages");
  const manifestPath = join(packageRoot, "package.json");
  const sourceManifest = validateSourceManifest(await readJson(manifestPath, "Source package manifest"));
  const archiveName = canonicalArchiveName(sourceManifest.version);
  const archivePath = join(archiveDirectory, archiveName);
  const expectedPath = resolve(repositoryRoot, "packages", archiveName);
  if (archivePath !== expectedPath) fail("Canonical package archive path escaped packages/.");
  return {
    repositoryRoot: resolve(repositoryRoot),
    packageRoot,
    archiveDirectory,
    archiveName,
    archivePath,
    sourceManifest
  };
}

export async function validatePackageBuildContract({ repositoryRoot = REPOSITORY_ROOT } = {}) {
  const sourceContract = await loadSourcePackageContract(repositoryRoot);
  const { packageRoot } = sourceContract;
  const expectedFiles = await expectedArchiveFiles(packageRoot);
  for (const target of Object.values(EXPECTED_BIN)) {
    const relativeTarget = target.replace(/^\.\//, "");
    if (!expectedFiles.includes(`package/${relativeTarget}`)) {
      fail(`Built package binary target is missing: ${relativeTarget}`);
    }
    const contents = await readBoundedText(
      join(packageRoot, relativeTarget),
      PACKAGE_MANIFEST_MAX_BYTES,
      "Built package binary"
    );
    if (!contents.startsWith("#!/usr/bin/env node\n")) {
      fail(`Built package binary is missing its Node shebang: ${relativeTarget}`);
    }
  }
  return {
    ...sourceContract,
    expectedFiles
  };
}

async function inspectArchive(archivePath, contract) {
  const before = await lstat(archivePath);
  if (!before.isFile() || before.isSymbolicLink()) fail(`Archive must be a regular file: ${archivePath}`);
  if (before.size === 0) fail(`Archive is empty: ${archivePath}`);

  const listing = await runCommand("tar", ["-tzf", archivePath], {
    cwd: contract.repositoryRoot,
    maximumStdoutBytes: TAR_LIST_MAX_BYTES
  });
  const archiveFiles = listing.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((entry) => !entry.endsWith("/"));
  const manifestResult = await runCommand("tar", ["-xOzf", archivePath, PACKED_MANIFEST_PATH], {
    cwd: contract.repositoryRoot,
    maximumStdoutBytes: PACKAGE_MANIFEST_MAX_BYTES
  });
  if (Buffer.byteLength(manifestResult.stdout, "utf8") > PACKAGE_MANIFEST_MAX_BYTES) {
    fail(`Packed package manifest exceeds ${PACKAGE_MANIFEST_MAX_BYTES} bytes.`);
  }

  let packedManifest;
  try {
    packedManifest = JSON.parse(manifestResult.stdout);
  } catch (error) {
    fail(`Packed package manifest contains malformed JSON: ${error.message}`);
  }
  const inventory = validatePackedContract({
    sourceManifest: contract.sourceManifest,
    packedManifest,
    archiveFiles,
    expectedFiles: contract.expectedFiles
  });
  const sha256 = await sha256File(archivePath, before.size);
  return { ...inventory, packedManifest, sha256, size: before.size };
}

function parsePackResult(stdout) {
  let result;
  try {
    result = JSON.parse(stdout);
  } catch (error) {
    fail(`npm pack did not return valid JSON: ${error.message}`);
  }
  if (!Array.isArray(result) || result.length !== 1 || typeof result[0]?.filename !== "string") {
    fail("npm pack must report exactly one filename.");
  }
  return result[0];
}

export async function packAuthoritativePackage({ repositoryRoot = REPOSITORY_ROOT } = {}) {
  let contract = await loadSourcePackageContract(repositoryRoot);
  const beforeCandidates = await scanArchiveDirectory(contract.archiveDirectory);
  const replaceable = validateArchiveCandidates(beforeCandidates, contract.archiveName, "before-pack");
  if (replaceable !== null) {
    const replaceablePath = join(contract.archiveDirectory, replaceable.name);
    const stats = await lstat(replaceablePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      fail(`Refusing to remove non-regular archive: ${replaceablePath}`);
    }
    await unlink(replaceablePath);
  }

  await cleanPackageBuildOutput(contract.packageRoot);
  const typescriptCli = resolve(contract.repositoryRoot, "node_modules/typescript/bin/tsc");
  const packageTypescriptConfig = resolve(contract.packageRoot, "tsconfig.json");
  await runCommand(process.execPath, [typescriptCli, "-p", packageTypescriptConfig], {
    cwd: contract.repositoryRoot
  });
  contract = await validatePackageBuildContract({ repositoryRoot: contract.repositoryRoot });

  const npmCache = await mkdtemp(join(tmpdir(), "skills-autoresearch-npm-cache-"));
  let packResult;
  try {
    const packed = await runCommand(
      "npm",
      ["pack", contract.packageRoot, "--pack-destination", contract.archiveDirectory, "--ignore-scripts", "--json"],
      {
        cwd: contract.repositoryRoot,
        env: {
          ...process.env,
          npm_config_cache: npmCache,
          npm_config_ignore_scripts: "true"
        },
        maximumStdoutBytes: TAR_LIST_MAX_BYTES
      }
    );
    packResult = parsePackResult(packed.stdout);
  } finally {
    await rm(npmCache, { recursive: true, force: true });
  }

  if (packResult.filename !== contract.archiveName || basename(packResult.filename) !== packResult.filename) {
    fail(`npm pack returned ${packResult.filename}; expected ${contract.archiveName}.`);
  }
  const returnedPath = resolve(contract.archiveDirectory, packResult.filename);
  if (returnedPath !== contract.archivePath) {
    fail(`npm pack returned an unexpected archive path: ${returnedPath}.`);
  }
  const afterCandidates = await scanArchiveDirectory(contract.archiveDirectory);
  validateArchiveCandidates(afterCandidates, contract.archiveName, "after-pack");

  const inspection = await inspectArchive(contract.archivePath, contract);
  return {
    packageName: PACKAGE_NAME,
    version: contract.sourceManifest.version,
    path: contract.archivePath,
    sha256: inspection.sha256,
    size: inspection.size,
    fileCount: inspection.fileCount,
    files: inspection.files
  };
}
