import { isAbsolute, relative, resolve } from "node:path";

export function resolveContainedPath(
  rootDir: string,
  path: string,
  messages: { absolute: (path: string) => string; outside: (path: string) => string }
): string {
  if (isAbsolute(path)) throw new Error(messages.absolute(path));
  const root = resolve(rootDir);
  const destination = resolve(root, path);
  const rel = relative(root, destination);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(messages.outside(path));
  return destination;
}
