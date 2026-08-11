import { createHash } from "node:crypto";

type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftPoints[index] - rightPoints[index];
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function normalizeString(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function normalizeJson(value: unknown, location = "$"): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" ? normalizeString(value) : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Cannot canonicalize non-finite number at ${location}`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeJson(item, `${location}[${index}]`));
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Cannot canonicalize non-plain object at ${location}`);
    }
    const normalizedEntries = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => [normalizeString(key), normalizeJson(item, `${location}.${key}`)] as const
    );
    const keys = normalizedEntries.map(([key]) => key);
    if (new Set(keys).size !== keys.length) {
      throw new TypeError(`Cannot canonicalize duplicate keys after Unicode normalization at ${location}`);
    }
    normalizedEntries.sort(([left], [right]) => compareCodePoints(left, right));
    return Object.fromEntries(normalizedEntries) as { [key: string]: JsonValue };
  }
  throw new TypeError(`Cannot canonicalize ${typeof value} at ${location}`);
}

/** Canonical JSON uses NFC strings, LF line endings, recursively sorted keys, and one final LF. */
export function serializeCanonical(value: unknown): string {
  return `${JSON.stringify(normalizeJson(value), null, 2)}\n`;
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalSha256(value: unknown): string {
  return sha256(serializeCanonical(value));
}

export function compareCanonicalIds(left: { id: string }, right: { id: string }): number {
  return compareCodePoints(left.id.normalize("NFC"), right.id.normalize("NFC"));
}
