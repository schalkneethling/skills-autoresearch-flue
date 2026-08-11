import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const artifactLibraryUrl = new URL("../scripts/package-artifact.mjs", import.meta.url);

type RootManifest = {
  scripts: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type PackageManifest = { name: string; version: string };

type PackageArtifactLibrary = {
  PACKAGE_NAME: string;
  PACKAGE_DIRECTORY: string;
  PACKED_MANIFEST_PATH: string;
  canonicalArchiveName(version: string): string;
  CLEAN_ROOM_PROOF_REQUIREMENTS: {
    offlineInstall: true;
    ignoreScripts: true;
    smoke: { score: number; modelCalls: number };
    determinization: { opportunities: number; recommendations: number; modelCalls: number; artifactCount: number };
  };
};

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

test("the root exposes package-contract, pack, proof, and demo scripts", async () => {
  const rootManifest = await readJson<RootManifest>(join(repositoryRoot, "package.json"));

  expect(rootManifest.devDependencies?.publint).toBeTruthy();
  expect(rootManifest.scripts["package:contract"]).toContain("publint");
  expect(rootManifest.scripts["package:pack"]).toBeTruthy();
  expect(rootManifest.scripts["package:proof"]).toBeTruthy();
  expect(rootManifest.scripts["demo:phase-1"]).toBeTruthy();
  expect(rootManifest.scripts.check).toContain("package:contract");
});

test("package artifact tooling and phase-one demo/progress documents have stable entrypoints", async () => {
  await Promise.all([
    access(join(repositoryRoot, "scripts", "package-artifact.mjs")),
    access(join(repositoryRoot, "scripts", "pack-package.mjs")),
    access(join(repositoryRoot, "scripts", "clean-room-package-proof.mjs")),
    access(join(repositoryRoot, "scripts", "demo-phase-1-installable-package.mjs")),
    access(join(repositoryRoot, "docs", "demos", "phase-1-installable-package.md")),
    access(join(repositoryRoot, "docs", "progress", "phase-1-installable-package.md"))
  ]);

  const demo = await readFile(join(repositoryRoot, "scripts", "demo-phase-1-installable-package.mjs"), "utf8");
  expect(demo).toContain("--keep");
});

test("the package artifact boundary fixes archive identity and proof expectations", async () => {
  const packageManifest = await readJson<PackageManifest>(
    join(repositoryRoot, "packages", "skills-autoresearch", "package.json")
  );
  const artifact = (await import(artifactLibraryUrl.href)) as PackageArtifactLibrary;

  expect(artifact.PACKAGE_NAME).toBe("@schalkneethling/skills-autoresearch");
  expect(artifact.PACKAGE_DIRECTORY).toBe("packages/skills-autoresearch");
  expect(artifact.PACKED_MANIFEST_PATH).toBe("package/package.json");
  expect(artifact.canonicalArchiveName(packageManifest.version)).toBe(
    `schalkneethling-skills-autoresearch-${packageManifest.version}.tgz`
  );
  expect(artifact.CLEAN_ROOM_PROOF_REQUIREMENTS).toEqual({
    offlineInstall: true,
    ignoreScripts: true,
    smoke: { score: 0.6, modelCalls: 0 },
    determinization: { opportunities: 1, recommendations: 3, modelCalls: 0, artifactCount: 6 }
  });
});
