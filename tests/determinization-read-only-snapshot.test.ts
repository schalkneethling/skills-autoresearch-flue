import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withReadOnlyInputs } from "../packages/skills-autoresearch/src/determinization/read-only-snapshot.js";
import type { SourceSelection } from "../packages/skills-autoresearch/src/determinization/source.js";

async function selectedFile() {
  const root = await mkdtemp(join(tmpdir(), "det-read-only-snapshot-"));
  const path = join(root, "SKILL.md");
  await writeFile(path, "original\n");
  const selections: SourceSelection[] = [{ namespace: "skill", root, paths: ["SKILL.md"] }];
  return { path, selections };
}

test("preserves an operation error when read-only inputs remain unchanged", async () => {
  const { selections } = await selectedFile();
  const operationError = new Error("operation failed");
  await expect(
    withReadOnlyInputs(selections, async () => {
      throw operationError;
    })
  ).rejects.toBe(operationError);
});

test("preserves both failures when an operation fails and read-only inputs change", async () => {
  const { path, selections } = await selectedFile();
  const operationError = new Error("operation failed");
  let caught: unknown;
  try {
    await withReadOnlyInputs(selections, async () => {
      await writeFile(path, "changed\n");
      throw operationError;
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  const aggregate = caught as AggregateError;
  expect(aggregate.message).toBe("Operation failed and determinization inputs changed");
  expect(aggregate.errors[0]).toBe(operationError);
  expect(aggregate.errors[1]).toMatchObject({ message: expect.stringMatching(/inputs are stale/) });
});
