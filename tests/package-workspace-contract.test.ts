import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const packageRoot = join(repositoryRoot, "packages", "skills-autoresearch");

type PackageManifest = {
  name?: string;
  version?: string;
  private?: boolean;
  type?: string;
  main?: string;
  module?: string;
  types?: string;
  exports?: unknown;
  files?: string[];
  bin?: Record<string, string>;
  repository?: { type?: string; url?: string; directory?: string };
  homepage?: string;
  bugs?: { url?: string };
  author?: unknown;
  keywords?: unknown;
  license?: string;
  engines?: { node?: string };
  publishConfig?: { access?: string; provenance?: boolean };
  dependencies?: Record<string, string>;
};

type TypeScriptConfig = {
  compilerOptions?: { rootDir?: string; outDir?: string };
  include?: string[];
  exclude?: string[];
};

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function expectDirectory(path: string): Promise<void> {
  expect((await stat(path)).isDirectory(), `${path} must be a directory`).toBe(true);
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

test("the private root declares the public package workspace", async () => {
  const rootManifest = await readJson<PackageManifest>(join(repositoryRoot, "package.json"));
  const workspace = await readFile(join(repositoryRoot, "pnpm-workspace.yaml"), "utf8");

  expect(rootManifest.private).toBe(true);
  expect(rootManifest.dependencies ?? {}).not.toHaveProperty("@flue/runtime");
  expect(rootManifest.dependencies ?? {}).not.toHaveProperty("valibot");
  expect(workspace).toMatch(/^\s*-\s*["']?packages\/\*["']?\s*$/m);
});

test("installs remain lifecycle-script free", async () => {
  const npmConfig = await readFile(join(repositoryRoot, ".npmrc"), "utf8");

  expect(npmConfig).toMatch(/^\s*ignore-scripts\s*=\s*true\s*$/m);
});

test("the package manifest defines the CLI-only publication contract", async () => {
  const manifest = await readJson<PackageManifest>(join(packageRoot, "package.json"));

  expect(manifest).toMatchObject({
    name: "@schalkneethling/skills-autoresearch",
    type: "module",
    license: "MIT",
    engines: { node: ">=24" },
    repository: {
      type: "git",
      url: "git+ssh://git@github.com/schalkneethling/skills-autoresearch-flue.git",
      directory: "packages/skills-autoresearch"
    },
    homepage: "https://github.com/schalkneethling/skills-autoresearch-flue#readme",
    bugs: { url: "https://github.com/schalkneethling/skills-autoresearch-flue/issues" },
    publishConfig: { access: "public", provenance: true },
    bin: {
      "skills-autoresearch": "./dist/cli.js",
      "skills-autoresearch-flue": "./dist/flue-runner.js"
    }
  });
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  expect(manifest.private).not.toBe(true);
  expect(manifest.author).toBeTruthy();
  expect(Array.isArray(manifest.keywords) && manifest.keywords.length > 0).toBe(true);

  // This package exposes commands, not a JavaScript or TypeScript library API.
  expect(manifest).not.toHaveProperty("main");
  expect(manifest).not.toHaveProperty("module");
  expect(manifest).not.toHaveProperty("types");
  expect(manifest).not.toHaveProperty("exports");

  expect(manifest.dependencies).toEqual({
    "@flue/runtime": "2.0.3",
    valibot: "^1.4.2"
  });
  expect(manifest.files).toEqual(["dist", "catalog/deterministic-assets", "README.md", "CHANGELOG.md", "LICENSE"]);
});

test("package compilation is isolated to publishable source", async () => {
  const config = await readJson<TypeScriptConfig>(join(packageRoot, "tsconfig.json"));
  const included = config.include ?? [];
  const excluded = config.exclude ?? [];

  expect(config.compilerOptions?.rootDir).toBe("src");
  expect(config.compilerOptions?.outDir).toBe("dist");
  expect(included.some((entry) => entry === "src" || entry.startsWith("src/"))).toBe(true);
  expect(included.every((entry) => !/(^|\/)tests?(\/|$)/.test(entry))).toBe(true);
  expect(excluded.every((entry) => !entry.startsWith("../"))).toBe(true);
});

test("publishable source and the deterministic catalog belong to the package", async () => {
  await expectDirectory(join(packageRoot, "src"));
  await expectDirectory(join(packageRoot, "catalog", "deterministic-assets"));
  await access(join(packageRoot, "src", "cli.ts"));
  await access(join(packageRoot, "src", "flue-runner.ts"));
  await access(join(packageRoot, "catalog", "deterministic-assets", "catalog.json"));

  await expectMissing(join(repositoryRoot, "src"));
  await expectMissing(join(repositoryRoot, "catalog"));
});

test("the repository and package ship the same MIT license", async () => {
  const repositoryLicense = await readFile(join(repositoryRoot, "LICENSE"), "utf8");
  const packageLicense = await readFile(join(packageRoot, "LICENSE"), "utf8");

  expect(packageLicense).toBe(repositoryLicense);
  expect(repositoryLicense).toMatch(/MIT License/);
  expect(repositoryLicense).toMatch(/Permission is hereby granted, free of charge/);
});
