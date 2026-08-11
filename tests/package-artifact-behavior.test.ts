import {
  validateArchiveCandidates,
  validatePackedContract
} from "../scripts/package-artifact.mjs";

const archiveName = "schalkneethling-skills-autoresearch-0.1.0.tgz";

const manifest = {
  name: "@schalkneethling/skills-autoresearch",
  version: "0.1.0",
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

  expect(
    validateArchiveCandidates([{ name: archiveName, type: "file" }], archiveName, "before-pack")
  ).toEqual({ name: archiveName, type: "file" });
  expect(
    validateArchiveCandidates([{ name: archiveName, type: "file" }], archiveName, "after-pack")
  ).toEqual({ name: archiveName, type: "file" });
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

  expect(() =>
    validateArchiveCandidates([{ name: archiveName, type: "symlink" }], archiveName, "before-pack")
  ).toThrow(/regular file/i);
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
