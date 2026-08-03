import type { SourceSelection } from "./source.js";
import { assertSourceManifestCurrent, createSourceManifest } from "./source.js";

export async function withReadOnlyInputs<T>(selections: SourceSelection[], operation: () => Promise<T>): Promise<T> {
  const before = await createSourceManifest(selections);
  try {
    return await operation();
  } finally {
    await assertSourceManifestCurrent(before, selections);
  }
}
