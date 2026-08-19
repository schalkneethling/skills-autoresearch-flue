import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  cleanPackageBuildOutput,
  packAuthoritativePackage,
  validateArchiveCandidates,
  validatePackedContract
} from "../scripts/package-artifact.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const archiveName = "schalkneethling-skills-autoresearch-0.1.0.tgz";
const execFileAsync = promisify(execFile);

const manifest = {
  name: "@schalkneethling/skills-autoresearch",
  version: "0.1.0",
  type: "module",
  exports: {},
  files: ["dist", "catalog/deterministic-assets", "README.md", "CHANGELOG.md", "LICENSE"],
  engines: { node: ">=24" },
  license: "MIT",
  repository: {
    type: "git",
    url: "git+ssh://git@github.com/schalkneethling/skills-autoresearch-flue.git",
    directory: "packages/skills-autoresearch"
  },
  publishConfig: { access: "public", provenance: true },
  bin: {
    "skills-autoresearch": "./dist/bin/skills-autoresearch.js",
    "skills-autoresearch-flue": "./dist/bin/skills-autoresearch-flue.js"
  },
  dependencies: {
    "@flue/runtime": "2.0.3",
    valibot: "^1.4.2"
  }
};

test("archive discovery distinguishes the replaceable pre-pack artifact from the authoritative result", () => {
  expect(validateArchiveCandidates([], archiveName, "before-pack")).toBeNull();
  expect(() => validateArchiveCandidates([], archiveName, "after-pack")).toThrow(/missing/i);

  expect(validateArchiveCandidates([{ name: archiveName, type: "file" }], archiveName, "before-pack")).toEqual({
    name: archiveName,
    type: "file"
  });
  expect(validateArchiveCandidates([{ name: archiveName, type: "file" }], archiveName, "after-pack")).toEqual({
    name: archiveName,
    type: "file"
  });
});

test("archive discovery rejects duplicates, unrelated names, and non-regular artifacts", () => {
  expect(() =>
    validateArchiveCandidates(
      [
        { name: archiveName, type: "file" },
        { name: archiveName, type: "file" }
      ],
      archiveName,
      "after-pack"
    )
  ).toThrow(/exactly one/i);

  expect(() =>
    validateArchiveCandidates(
      [{ name: "schalkneethling-skills-autoresearch-0.0.9.tgz", type: "file" }],
      archiveName,
      "before-pack"
    )
  ).toThrow(/unexpected archive/i);

  expect(() => validateArchiveCandidates([{ name: archiveName, type: "symlink" }], archiveName, "before-pack")).toThrow(
    /regular file/i
  );
});

test("packed validation compares manifest identity and the complete allowlisted inventory", () => {
  const expectedFiles = [
    "package/CHANGELOG.md",
    "package/LICENSE",
    "package/README.md",
    "package/catalog/deterministic-assets/catalog.json",
    "package/dist/bin/skills-autoresearch-flue.js",
    "package/dist/bin/skills-autoresearch.js",
    "package/package.json"
  ];

  expect(
    validatePackedContract({
      sourceManifest: manifest,
      packedManifest: structuredClone(manifest),
      archiveFiles: [...expectedFiles].reverse(),
      expectedFiles
    })
  ).toEqual({ fileCount: expectedFiles.length, files: expectedFiles });

  expect(() =>
    validatePackedContract({
      sourceManifest: manifest,
      packedManifest: { ...manifest, dependencies: { valibot: "^1.4.2" } },
      archiveFiles: expectedFiles,
      expectedFiles
    })
  ).toThrow(/dependencies/i);

  expect(() =>
    validatePackedContract({
      sourceManifest: manifest,
      packedManifest: structuredClone(manifest),
      archiveFiles: [...expectedFiles, "package/src/cli.ts"],
      expectedFiles
    })
  ).toThrow(/not allowlisted/i);
});

test("package build cleanup removes stale output and refuses symlinked dist directories", async () => {
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "skills-autoresearch-artifact-test-")));
  const packageRoot = join(temporaryRoot, "package");
  const externalRoot = join(temporaryRoot, "external");
  try {
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(join(packageRoot, "dist", "stale.js"), "stale output\n", "utf8");

    await expect(cleanPackageBuildOutput(packageRoot)).resolves.toBe(true);
    await expect(access(join(packageRoot, "dist", "stale.js"))).rejects.toMatchObject({
      code: "ENOENT"
    });

    await mkdir(externalRoot);
    await writeFile(join(externalRoot, "keep.js"), "keep me\n", "utf8");
    await symlink(externalRoot, join(packageRoot, "dist"), "dir");

    await expect(cleanPackageBuildOutput(packageRoot)).rejects.toThrow(/regular directory/i);
    await expect(access(join(externalRoot, "keep.js"))).resolves.toBeUndefined();
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("authoritative packing rebuilds before deriving the packed inventory", async () => {
  await expect(execFileAsync("npm", ["--version"])).resolves.toBeDefined();
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "skills-autoresearch-pack-test-")));
  const packageRoot = join(temporaryRoot, "packages", "skills-autoresearch");
  const staleOutput = join(packageRoot, "dist", "stale-output.js");
  try {
    await mkdir(join(temporaryRoot, "packages"), { recursive: true });
    await cp(join(repositoryRoot, "packages", "skills-autoresearch"), packageRoot, {
      recursive: true
    });
    await symlink(join(repositoryRoot, "node_modules"), join(temporaryRoot, "node_modules"), "dir");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await writeFile(staleOutput, "stale output\n", "utf8");

    const result = await packAuthoritativePackage({ repositoryRoot: temporaryRoot });

    expect(result.path).toBe(join(temporaryRoot, "packages", archiveName));
    expect(result.files).not.toContain("package/dist/stale-output.js");
    await expect(access(staleOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(result.path)).resolves.toBeUndefined();
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}, 30_000);
