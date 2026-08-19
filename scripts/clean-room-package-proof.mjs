#!/usr/bin/env node
import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { CLEAN_ROOM_PROOF_REQUIREMENTS, packAuthoritativePackage } from "./package-artifact.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 1024 * 1024;
const REPORT_LIMIT_BYTES = 512 * 1024;
const FIXTURE_RELATIVE_PATH = "fixtures/projects/release-notes-alpha";
const RESPONSE_RELATIVE_PATH = "fixtures/expected/determinization/release-notes-alpha/analysis-response.json";
const EXPECTED_REPORT_RELATIVE_PATH = "fixtures/expected/determinization/release-notes-alpha/report.md";
const EXPECTED_ARTIFACT_FILES = [
  "opportunities.json",
  "prompts/research.md",
  "report.md",
  "research-request.json",
  "source.json",
  "transcript.json"
];
const FIXTURE_COPY_ENTRIES = [
  "config.json",
  "evals",
  "input",
  "reference",
  "roles",
  "seed-skill",
  "workspace/baseline"
];
const PROJECT_SNAPSHOT_ENTRIES = [
  "config.json",
  "evals",
  "input",
  "reference",
  "roles",
  "seed-skill",
  "workspace/baseline"
];
const DEPLOYED_PACKAGE_FILES = ["dist", "catalog", "README.md", "CHANGELOG.md", "LICENSE"];

const HELP = `Prove the packed Skills Autoresearch CLI in an offline clean room.

Usage:
  node scripts/clean-room-package-proof.mjs [--json] [--keep]

Options:
  --json  Print a machine-readable proof summary.
  --keep  Preserve the temporary clean-room workspace for inspection.
  --help  Show this help.
`;

function fail(message) {
  throw new Error(message);
}

function compareCodePoints(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sanitizedChildEnvironment() {
  const environment = {};
  const sensitiveName =
    /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|ANTHROPIC|OPENAI|GEMINI|MISTRAL|COHERE|AZURE|AWS_|GOOGLE_|FLUE_MODEL|VARLOCK|ONEPASSWORD|OP_)/iu;
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !sensitiveName.test(name)) environment[name] = value;
  }
  return {
    ...environment,
    npm_config_ignore_scripts: "true"
  };
}

async function runCommand(command, args, { cwd, env, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
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
    let failure;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      failure = `${basename(command)} timed out after ${timeoutMs} milliseconds.`;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > COMMAND_OUTPUT_LIMIT_BYTES) {
        failure = `${basename(command)} stdout exceeded ${COMMAND_OUTPUT_LIMIT_BYTES} bytes.`;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > COMMAND_OUTPUT_LIMIT_BYTES) {
        failure = `${basename(command)} stderr exceeded ${COMMAND_OUTPUT_LIMIT_BYTES} bytes.`;
        child.kill("SIGKILL");
        return;
      }
      stderr.push(chunk);
    });
    child.on("error", (error) => finish(rejectPromise, error));
    child.on("close", (code, signal) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (failure) return finish(rejectPromise, new Error(failure));
      if (code !== 0) {
        const diagnostic = errorOutput.trim() || output.trim() || "no output";
        return finish(
          rejectPromise,
          new Error(`${basename(command)} failed (${signal ?? `exit ${code}`}): ${diagnostic}`)
        );
      }
      finish(resolvePromise, { stdout: output, stderr: errorOutput });
    });
  });
}

async function readBoundedText(path, maximumBytes, label) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) fail(`${label} must be a regular file: ${path}`);
  if (before.size > maximumBytes) fail(`${label} exceeds ${maximumBytes} bytes: ${path}`);
  const contents = await readFile(path, "utf8");
  if (Buffer.byteLength(contents, "utf8") > maximumBytes) {
    fail(`${label} exceeds ${maximumBytes} bytes after reading: ${path}`);
  }
  return contents;
}

function parseJsonOutput(output, label) {
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(`${label} did not return valid JSON: ${error.message}`);
  }
}

async function hashRegularFile(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) fail(`Snapshot entry must be a regular file: ${path}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const after = await lstat(path);
  if (!after.isFile() || after.isSymbolicLink() || after.size !== before.size) {
    fail(`Snapshot entry changed while hashing: ${path}`);
  }
  return { sha256: hash.digest("hex"), size: after.size };
}

async function collectSnapshotEntries(root, current = root) {
  const metadata = await lstat(current);
  if (metadata.isSymbolicLink()) fail(`Snapshot roots must not contain symbolic links: ${current}`);
  if (metadata.isFile()) return [{ path: "", ...(await hashRegularFile(current)) }];
  if (!metadata.isDirectory()) fail(`Snapshot roots must contain only files and directories: ${current}`);

  const result = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => compareCodePoints(left.name, right.name));
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const entryMetadata = await lstat(absolute);
    if (entryMetadata.isSymbolicLink()) fail(`Snapshot roots must not contain symbolic links: ${absolute}`);
    if (entryMetadata.isDirectory()) {
      result.push(...(await collectSnapshotEntries(root, absolute)));
    } else if (entryMetadata.isFile()) {
      result.push({ path: relative(root, absolute).split(sep).join("/"), ...(await hashRegularFile(absolute)) });
    } else {
      fail(`Snapshot roots must contain only files and directories: ${absolute}`);
    }
  }
  return result;
}

async function snapshotProtectedInputs(projectRoot, catalogRoot) {
  const snapshot = {};
  for (const entry of PROJECT_SNAPSHOT_ENTRIES) {
    snapshot[`project/${entry}`] = await collectSnapshotEntries(join(projectRoot, entry));
  }
  snapshot["installed/catalog/deterministic-assets"] = await collectSnapshotEntries(catalogRoot);
  return snapshot;
}

async function copyFixture(repositoryRoot, projectRoot, responsePath) {
  const fixtureRoot = resolve(repositoryRoot, FIXTURE_RELATIVE_PATH);
  await mkdir(projectRoot, { recursive: true });
  for (const entry of FIXTURE_COPY_ENTRIES) {
    const source = join(fixtureRoot, entry);
    const destination = join(projectRoot, entry);
    const metadata = await lstat(source);
    if (metadata.isSymbolicLink()) fail(`Fixture entries must not be symbolic links: ${source}`);
    if (metadata.isDirectory()) {
      await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    } else if (metadata.isFile()) {
      await mkdir(resolve(destination, ".."), { recursive: true });
      await copyFile(source, destination);
    } else {
      fail(`Fixture entries must be files or directories: ${source}`);
    }
  }
  await copyFile(resolve(repositoryRoot, RESPONSE_RELATIVE_PATH), responsePath);
}

function assertStrictDescendant(root, target, label) {
  const relationship = relative(resolve(root), resolve(target));
  if (!relationship || relationship === ".." || relationship.startsWith(`..${sep}`)) {
    fail(`${label} must remain a strict descendant of the clean-room workspace: ${target}`);
  }
}

async function replaceDeployedPackageWithConsumer(workspaceRoot, installRoot) {
  assertStrictDescendant(workspaceRoot, installRoot, "Install root");
  const installMetadata = await lstat(installRoot);
  if (!installMetadata.isDirectory() || installMetadata.isSymbolicLink()) {
    fail(`Deployed install root must be a regular directory: ${installRoot}`);
  }
  const resolvedWorkspace = await realpath(workspaceRoot);
  const resolvedInstallRoot = await realpath(installRoot);
  assertStrictDescendant(resolvedWorkspace, resolvedInstallRoot, "Resolved install root");

  for (const entry of DEPLOYED_PACKAGE_FILES) {
    const target = join(resolvedInstallRoot, entry);
    assertStrictDescendant(resolvedInstallRoot, target, "Deployed package file");
    try {
      await lstat(target);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        fail(`Frozen-lock deployment did not produce the expected package-owned path: ${target}`);
      }
      throw error;
    }
    await rm(target, { recursive: true, force: true });
  }

  await writeFile(
    join(resolvedInstallRoot, "package.json"),
    `${JSON.stringify({ name: "skills-autoresearch-clean-room", version: "0.0.0", private: true }, null, 2)}\n`
  );
  await writeFile(
    join(resolvedInstallRoot, "pnpm-workspace.yaml"),
    ["allowBuilds:", '  "@google/genai": false', "  protobufjs: false", ""].join("\n")
  );
}

async function collectArtifactFiles(root, current = root) {
  const result = [];
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => compareCodePoints(left.name, right.name));
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) fail(`Determinization artifacts must not contain symbolic links: ${absolute}`);
    if (metadata.isDirectory()) {
      result.push(...(await collectArtifactFiles(root, absolute)));
    } else if (metadata.isFile()) {
      result.push(relative(root, absolute).split(sep).join("/"));
    } else {
      fail(`Determinization artifacts must contain only regular files: ${absolute}`);
    }
  }
  return result.sort(compareCodePoints);
}

function assertHelpAndVersion({ commandName, help, version, expectedVersion }) {
  if (!help.stdout.includes("Usage:")) fail(`${commandName} --help did not print usage.`);
  if (version.stdout.trim() !== expectedVersion) {
    fail(`${commandName} --version returned ${JSON.stringify(version.stdout.trim())}; expected ${expectedVersion}.`);
  }
}

export async function runCleanRoomPackageProof({
  repositoryRoot = REPOSITORY_ROOT,
  keep = false,
  onProgress = () => {}
} = {}) {
  const root = resolve(repositoryRoot);
  onProgress("Building and inspecting the authoritative package archive");
  const artifact = await packAuthoritativePackage({ repositoryRoot: root });
  const workspaceRoot = await mkdtemp(join(tmpdir(), "skills autoresearch clean room "));
  const installRoot = join(workspaceRoot, "installed package");
  const projectRoot = join(workspaceRoot, "release notes project");
  const responsePath = join(workspaceRoot, "recorded determinization response.json");
  const childEnvironment = sanitizedChildEnvironment();

  try {
    await copyFixture(root, projectRoot, responsePath);

    onProgress("Seeding the clean room from the repository's frozen dependency lock");
    await runCommand(
      "pnpm",
      [
        "--filter",
        "@schalkneethling/skills-autoresearch",
        "deploy",
        "--prod",
        "--legacy",
        "--offline",
        "--ignore-scripts",
        installRoot
      ],
      { cwd: root, env: childEnvironment }
    );
    await replaceDeployedPackageWithConsumer(workspaceRoot, installRoot);

    onProgress("Installing that exact archive offline with lifecycle scripts disabled");
    await runCommand("pnpm", ["add", "--offline", "--ignore-scripts", "--save-exact", artifact.path], {
      cwd: installRoot,
      env: childEnvironment
    });

    const installedPackageRoot = await realpath(
      join(installRoot, "node_modules", "@schalkneethling", "skills-autoresearch")
    );
    const installedCatalogRoot = join(installedPackageRoot, "catalog", "deterministic-assets");
    const directBin = join(installRoot, "node_modules", ".bin", "skills-autoresearch");
    const flueBin = join(installRoot, "node_modules", ".bin", "skills-autoresearch-flue");

    onProgress("Checking help and version through both installed binary shims");
    const [directHelp, directVersion, flueHelp, flueVersion] = await Promise.all([
      runCommand(directBin, ["--help"], { cwd: workspaceRoot, env: childEnvironment }),
      runCommand(directBin, ["--version"], { cwd: workspaceRoot, env: childEnvironment }),
      runCommand(flueBin, ["--help"], { cwd: workspaceRoot, env: childEnvironment }),
      runCommand(flueBin, ["--version"], { cwd: workspaceRoot, env: childEnvironment })
    ]);
    assertHelpAndVersion({
      commandName: "skills-autoresearch",
      help: directHelp,
      version: directVersion,
      expectedVersion: artifact.version
    });
    assertHelpAndVersion({
      commandName: "skills-autoresearch-flue",
      help: flueHelp,
      version: flueVersion,
      expectedVersion: artifact.version
    });

    const before = await snapshotProtectedInputs(projectRoot, installedCatalogRoot);

    onProgress("Running the installed Flue smoke path without model calls");
    const smokeCommand = await runCommand(
      flueBin,
      ["smoke", "--project", projectRoot, "--session", "phase-1-clean-room", "--no-run-log", "--verbose"],
      { cwd: workspaceRoot, env: childEnvironment }
    );
    const smoke = parseJsonOutput(smokeCommand.stdout, "Flue smoke command");
    if (smoke.normalizedScore !== CLEAN_ROOM_PROOF_REQUIREMENTS.smoke.score) {
      fail(
        `Flue smoke score was ${JSON.stringify(smoke.normalizedScore)}; expected ${CLEAN_ROOM_PROOF_REQUIREMENTS.smoke.score.toFixed(3)}.`
      );
    }
    if (smoke.cost?.actual?.totalCalls !== CLEAN_ROOM_PROOF_REQUIREMENTS.smoke.modelCalls) {
      fail(
        `Flue smoke made ${JSON.stringify(smoke.cost?.actual?.totalCalls)} model calls; expected ${CLEAN_ROOM_PROOF_REQUIREMENTS.smoke.modelCalls}.`
      );
    }

    onProgress("Running recorded-response determinization with the bundled catalog");
    const determinizationCommand = await runCommand(
      directBin,
      ["determinize", "report", "--project", projectRoot, "--response-file", responsePath, "--json"],
      { cwd: workspaceRoot, env: childEnvironment }
    );
    const determinization = parseJsonOutput(determinizationCommand.stdout, "Recorded-response determinization");
    const expectedDeterminization = CLEAN_ROOM_PROOF_REQUIREMENTS.determinization;
    if (determinization.opportunityCount !== expectedDeterminization.opportunities) {
      fail(
        `Determinization produced ${JSON.stringify(determinization.opportunityCount)} opportunities; expected ${expectedDeterminization.opportunities}.`
      );
    }
    if (determinization.recommendationCount !== expectedDeterminization.recommendations) {
      fail(
        `Determinization produced ${JSON.stringify(determinization.recommendationCount)} recommendations; expected ${expectedDeterminization.recommendations}.`
      );
    }
    if (determinization.cost?.actualCalls !== expectedDeterminization.modelCalls) {
      fail(
        `Determinization made ${JSON.stringify(determinization.cost?.actualCalls)} model calls; expected ${expectedDeterminization.modelCalls}.`
      );
    }

    const artifactRoot = join(projectRoot, "workspace", "determinization");
    const artifactFiles = await collectArtifactFiles(artifactRoot);
    if (
      artifactFiles.length !== expectedDeterminization.artifactCount ||
      !isDeepStrictEqual(artifactFiles, EXPECTED_ARTIFACT_FILES)
    ) {
      fail(
        `Determinization artifacts were ${JSON.stringify(artifactFiles)}; expected exactly ${JSON.stringify(EXPECTED_ARTIFACT_FILES)}.`
      );
    }
    const generatedReport = await readBoundedText(
      join(artifactRoot, "report.md"),
      REPORT_LIMIT_BYTES,
      "Generated report"
    );
    const expectedReport = await readBoundedText(
      resolve(root, EXPECTED_REPORT_RELATIVE_PATH),
      REPORT_LIMIT_BYTES,
      "Expected report"
    );
    if (generatedReport !== expectedReport)
      fail("Generated determinization report does not match the expected fixture.");

    const after = await snapshotProtectedInputs(projectRoot, installedCatalogRoot);
    if (!isDeepStrictEqual(after, before)) {
      fail(
        "The skill, configuration, evals, inputs, references, roles, imported baseline, or installed catalog changed during proof."
      );
    }

    const result = {
      packageName: artifact.packageName,
      version: artifact.version,
      archive: {
        path: artifact.path,
        sha256: artifact.sha256,
        size: artifact.size,
        fileCount: artifact.fileCount
      },
      workspace: {
        path: workspaceRoot,
        preserved: keep
      },
      installedBinaries: ["skills-autoresearch", "skills-autoresearch-flue"],
      smoke: {
        score: smoke.normalizedScore,
        modelCalls: smoke.cost.actual.totalCalls
      },
      determinization: {
        opportunities: determinization.opportunityCount,
        recommendations: determinization.recommendationCount,
        modelCalls: determinization.cost.actualCalls,
        report: determinization.paths.report,
        artifactFiles
      },
      readOnlyInputsUnchanged: true,
      credentialsUsed: false,
      offlineInstall: true,
      lifecycleScriptsDisabled: true
    };
    onProgress("Clean-room package proof passed");
    return result;
  } catch (error) {
    if (keep) error.cleanRoomWorkspace = workspaceRoot;
    throw error;
  } finally {
    if (!keep) await rm(workspaceRoot, { recursive: true, force: true });
  }
}

function formatHumanResult(result) {
  return [
    `Package proof passed: ${result.packageName}@${result.version}`,
    `Archive: ${result.archive.path}`,
    `SHA-256: ${result.archive.sha256}`,
    `Size: ${result.archive.size} bytes`,
    `Contents: ${result.archive.fileCount} files`,
    `Installed binaries: ${result.installedBinaries.join(", ")}`,
    `Flue smoke: score ${result.smoke.score.toFixed(3)}; model calls ${result.smoke.modelCalls}`,
    `Determinization: ${result.determinization.opportunities} opportunity; ${result.determinization.recommendations} recommendations; model calls ${result.determinization.modelCalls}`,
    `Artifacts: ${result.determinization.artifactFiles.length} files; report ${result.determinization.report}`,
    "Protected project inputs, imported baseline, and installed catalog: unchanged",
    `Workspace: ${result.workspace.path} (${result.workspace.preserved ? "preserved" : "cleaned"})`
  ].join("\n");
}

async function main(args) {
  if (args.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const unknown = args.filter((argument) => argument !== "--json" && argument !== "--keep");
  if (unknown.length > 0) fail(`Unknown option(s): ${unknown.join(", ")}`);
  const json = args.includes("--json");
  const result = await runCleanRoomPackageProof({
    keep: args.includes("--keep"),
    onProgress: json ? undefined : (message) => process.stderr.write(`• ${message}\n`)
  });
  process.stdout.write(json ? `${JSON.stringify(result, null, 2)}\n` : `${formatHumanResult(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    if (error?.cleanRoomWorkspace) process.stderr.write(`Workspace preserved: ${error.cleanRoomWorkspace}\n`);
    process.exitCode = 1;
  });
}
