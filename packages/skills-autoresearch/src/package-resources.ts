import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

export function resolvePackageResource(...segments: string[]): string {
  return join(packageRoot, ...segments);
}

export function resolveBundledCatalogRoot(): string {
  return resolvePackageResource("catalog", "deterministic-assets");
}

export async function readPackageVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(resolvePackageResource("package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("The installed Skills Autoresearch package has no valid version.");
  }
  return manifest.version;
}
