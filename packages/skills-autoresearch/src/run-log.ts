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
  const safeSessionId = (sessionId.replaceAll(/[^a-zA-Z0-9._-]/g, "-") || "autoresearch").slice(0, 96);
  const path = join(directory, `${timestamp}-${safeSessionId}-${randomUUID()}.ndjson`);
  const descriptor = openSync(path, "wx");
  let closed = false;

  return {
    path,
    append(type, data) {
      if (closed) {
        return;
      }
      writeSync(
        descriptor,
        `${JSON.stringify({ timestamp: new Date().toISOString(), type, data: sanitizeRecord(type, data) })}\n`
      );
    },
    close() {
      if (!closed) {
        closeSync(descriptor);
        closed = true;
      }
    }
  };
}

const SENSITIVE_KEY = /(?:api[-_]?key|authorization|cookie|password|secret|token|transcript|payload|response)/iu;
const SECRET_VALUE =
  /(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16}|Bearer\s+\S+)/gu;
const RUN_START_KEYS = new Set(["command", "workflow", "projectRoot", "sessionId"]);
const RUN_RESULT_KEYS = new Set([
  "completedIterations",
  "normalizedScore",
  "bestSkillDir",
  "selectedSkillDir",
  "selectedSkillSource",
  "opportunityCount",
  "recommendationCount",
  "paths",
  "cost"
]);

function sanitizeRecord(type: string, value: unknown): unknown {
  const allowlist = type === "run-start" ? RUN_START_KEYS : type === "run-result" ? RUN_RESULT_KEYS : undefined;
  if (!allowlist || value === null || typeof value !== "object" || Array.isArray(value)) return redact(value);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => allowlist.has(key))
      .map(([key, item]) => [key, redact(item)])
  );
}

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return value.replaceAll(SECRET_VALUE, "[REDACTED]");
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, seen)])
  );
}
