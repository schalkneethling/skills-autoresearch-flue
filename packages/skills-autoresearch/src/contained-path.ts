import { lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export function assertNoSymlinkPathComponents(rootDir: string, destination: string): void {
  const root = resolve(rootDir);
  const rel = relative(root, resolve(destination));
  const components = [
    root,
    ...rel
      .split(sep)
      .filter(Boolean)
      .map((_, index, parts) => join(root, ...parts.slice(0, index + 1)))
  ];
  for (const component of components) {
    try {
      if (lstatSync(component).isSymbolicLink()) throw new Error(`Path component must not be a symlink: ${component}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export function resolveContainedPath(
  rootDir: string,
  path: string,
  messages: { absolute: (path: string) => string; outside: (path: string) => string }
): string {
  if (isAbsolute(path)) throw new Error(messages.absolute(path));
  const root = resolve(rootDir);
  const destination = resolve(root, path);
  const rel = relative(root, destination);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(messages.outside(path));
  }
  assertNoSymlinkPathComponents(root, destination);
  return destination;
}
