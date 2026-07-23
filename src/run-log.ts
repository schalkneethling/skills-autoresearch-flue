import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export type RunLog = {
  path: string;
  append(type: string, data: unknown): void;
  close(): void;
};

export function createRunLog(projectRoot: string, sessionId = "autoresearch"): RunLog {
  const directory = join(resolve(projectRoot), "workspace", "run-logs");
  mkdirSync(directory, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const safeSessionId = sessionId.replaceAll(/[^a-zA-Z0-9._-]/g, "-") || "autoresearch";
  const path = join(directory, `${timestamp}-${safeSessionId}-${randomUUID()}.ndjson`);
  const descriptor = openSync(path, "wx");
  let closed = false;

  return {
    path,
    append(type, data) {
      if (closed) {
        return;
      }
      writeSync(descriptor, `${JSON.stringify({ timestamp: new Date().toISOString(), type, data })}\n`);
    },
    close() {
      if (!closed) {
        closeSync(descriptor);
        closed = true;
      }
    }
  };
}
