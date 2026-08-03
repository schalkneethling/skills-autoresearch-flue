import type { SourceSelection } from "./source.js";
import { assertSourceManifestCurrent, createSourceManifest } from "./source.js";

export async function withReadOnlyInputs<T>(selections: SourceSelection[], operation: () => Promise<T>): Promise<T> {
  const before = await createSourceManifest(selections);
  let result: T;
  try {
    result = await operation();
  } catch (operationError) {
    try {
      await assertSourceManifestCurrent(before, selections);
    } catch (mutationError) {
      throw new AggregateError([operationError, mutationError], "Operation failed and determinization inputs changed", {
        cause: mutationError
      });
    }
    throw operationError;
  }
  await assertSourceManifestCurrent(before, selections);
  return result;
}
