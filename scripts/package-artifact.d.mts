export const PACKAGE_NAME: "@schalkneethling/skills-autoresearch";
export const PACKAGE_DIRECTORY: "packages/skills-autoresearch";
export const PACKED_MANIFEST_PATH: "package/package.json";
export const CLEAN_ROOM_PROOF_REQUIREMENTS: Readonly<{
  offlineInstall: true;
  ignoreScripts: true;
  smoke: Readonly<{ score: 0.6; modelCalls: 0 }>;
  determinization: Readonly<{
    opportunities: 1;
    recommendations: 3;
    modelCalls: 0;
    artifactCount: 6;
  }>;
}>;

export type ArchiveCandidate = Readonly<{
  name: string;
  type: "file" | "symlink" | "directory" | "other";
}>;

export type ValidatedPackageManifest = Record<string, unknown> & {
  name: typeof PACKAGE_NAME;
  version: string;
  license: "MIT";
  repository: {
    type: "git";
    url: "git+ssh://git@github.com/schalkneethling/skills-autoresearch-flue.git";
    directory: typeof PACKAGE_DIRECTORY;
  };
  publishConfig: { access: "public"; provenance: true };
  bin: {
    "skills-autoresearch": "./dist/bin/skills-autoresearch.js";
    "skills-autoresearch-flue": "./dist/bin/skills-autoresearch-flue.js";
  };
  dependencies: Record<string, string>;
};

export type PackageBuildContract = {
  repositoryRoot: string;
  packageRoot: string;
  archiveDirectory: string;
  archiveName: string;
  archivePath: string;
  sourceManifest: ValidatedPackageManifest;
  expectedFiles: string[];
};

export type PackageArtifactSummary = {
  packageName: typeof PACKAGE_NAME;
  version: string;
  path: string;
  sha256: string;
  size: number;
  fileCount: number;
  files: string[];
};

export function canonicalArchiveName(version: string): string;

export function validateSourceManifest(manifest: unknown): ValidatedPackageManifest;

export function validateArchiveCandidates(
  candidates: readonly ArchiveCandidate[],
  expectedName: string,
  mode: "before-pack" | "after-pack"
): ArchiveCandidate | null;

export function validatePackedContract(input: {
  sourceManifest: unknown;
  packedManifest: unknown;
  archiveFiles: readonly string[];
  expectedFiles: readonly string[];
}): { fileCount: number; files: string[] };

export function cleanPackageBuildOutput(packageRoot: string): Promise<boolean>;

export function validatePackageBuildContract(options?: { repositoryRoot?: string }): Promise<PackageBuildContract>;

export function packAuthoritativePackage(options?: { repositoryRoot?: string }): Promise<PackageArtifactSummary>;
