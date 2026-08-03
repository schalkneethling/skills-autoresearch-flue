import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSourceManifestCurrent,
  createSourceManifest,
  serializeSourceManifest,
  type AnalysisIdentity
} from "../src/determinization/source.js";

test("source manifests use logical namespaces and raw-byte hashes without machine paths", async () => {
  const one = await mkdtemp(join(tmpdir(), "det-source-one-"));
  const two = await mkdtemp(join(tmpdir(), "det-source-two-"));
  await writeFile(join(one, "SKILL.md"), "same\r\nbytes\n");
  await writeFile(join(two, "SKILL.md"), "same\r\nbytes\n");
  const first = await createSourceManifest([{ namespace: "skill", root: one, paths: ["SKILL.md"] }]);
  const second = await createSourceManifest([{ namespace: "skill", root: two, paths: ["SKILL.md"] }]);
  expect(serializeSourceManifest(first)).toBe(serializeSourceManifest(second));
  expect(serializeSourceManifest(first)).not.toContain(one);
  await writeFile(join(two, "SKILL.md"), "same\nbytes\n");
  await expect(
    assertSourceManifestCurrent(first, [{ namespace: "skill", root: two, paths: ["SKILL.md"] }])
  ).rejects.toThrow(/stale/);
});

test("source manifests include only canonical, portable analysis identity metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "det-source-analysis-"));
  await writeFile(join(root, "SKILL.md"), "content\n");
  const selection = [{ namespace: "skill" as const, root, paths: ["SKILL.md"] }];
  const manifest = await createSourceManifest(selection, {
    role: "determinizer",
    transport: "flue",
    model: { provider: "anthropic", name: "configured_model" }
  });
  const serialized = serializeSourceManifest(manifest);
  expect(serialized).toContain('"role": "determinizer"');
  expect(serialized).toContain('"transport": "flue"');
  expect(serialized).not.toContain(root);
  await expect(
    createSourceManifest(selection, {
      role: "determinizer",
      transport: "/tmp/private-transport"
    })
  ).rejects.toThrow(/portable nonblank/);
  await expect(
    createSourceManifest(selection, {
      role: "determinizer",
      transport: "flue",
      model: { provider: "  " }
    })
  ).rejects.toThrow(/portable nonblank/);
  await expect(
    createSourceManifest(selection, {
      role: "determinizer",
      transport: "flue",
      request_sha256: "not-a-hash",
      response_sha256: "0".repeat(64)
    })
  ).rejects.toThrow(/strict SHA-256/);
  await expect(
    createSourceManifest(selection, {
      role: "determinizer",
      transport: "flue",
      request_sha256: "0".repeat(64)
    })
  ).rejects.toThrow(/provided together/);
  await expect(
    createSourceManifest(selection, {
      role: "determinizer",
      transport: 123
    } as unknown as AnalysisIdentity)
  ).rejects.toThrow(/transport must be a portable nonblank identifier/);
  await expect(
    createSourceManifest(selection, {
      role: "determinizer",
      transport: "flue",
      request_sha256: 123,
      response_sha256: 123
    } as unknown as AnalysisIdentity)
  ).rejects.toThrow(/strict SHA-256/);
  await expect(
    createSourceManifest(selection, {
      role: "determinizer",
      transport: "flue",
      model: { provider: 123 }
    } as unknown as AnalysisIdentity)
  ).rejects.toThrow(/model provider must be a portable nonblank identifier/);
  await expect(
    createSourceManifest(selection, {
      role: "determinizer",
      transport: "flue",
      model: { name: 123 }
    } as unknown as AnalysisIdentity)
  ).rejects.toThrow(/model name must be a portable nonblank identifier/);
  await expect(createSourceManifest(selection, null as unknown as AnalysisIdentity)).rejects.toThrow(
    /analysis identity must be an object/
  );
  await expect(createSourceManifest(selection, 123 as unknown as AnalysisIdentity)).rejects.toThrow(
    /analysis identity must be an object/
  );
});

test("source selection rejects traversal, symlinks, and special files", async () => {
  const root = await mkdtemp(join(tmpdir(), "det-source-safety-"));
  const outside = join(root, "outside.md");
  const inputs = join(root, "inputs");
  await mkdir(inputs);
  await writeFile(outside, "outside");
  await symlink(outside, join(inputs, "linked.md"));
  await mkdir(join(inputs, "nested"));
  await symlink(root, join(inputs, "nested", "escaped"));
  await expect(createSourceManifest([{ namespace: "skill", root: inputs, paths: ["../outside.md"] }])).rejects.toThrow(
    /source-relative/
  );
  await expect(createSourceManifest([{ namespace: "skill", root: inputs, paths: ["linked.md"] }])).rejects.toThrow(
    /Symbolic links/
  );
  await expect(
    createSourceManifest([{ namespace: "skill", root: inputs, paths: ["nested/escaped/outside.md"] }])
  ).rejects.toThrow(/Symbolic links/);
  await expect(createSourceManifest([{ namespace: "skill", root, paths: ["inputs"] }])).rejects.toThrow(
    /regular files/
  );
  await writeFile(join(inputs, "SKILL.md"), "content\n");
  await expect(
    createSourceManifest([
      { namespace: "skill", root: inputs, paths: ["SKILL.md"] },
      { namespace: "skill", root: inputs, paths: ["SKILL.md"] }
    ])
  ).rejects.toThrow(/Duplicate selected source path/);
  expect(await readFile(outside, "utf8")).toBe("outside");
});

test("source manifest entries use Unicode code-point ordering", async () => {
  const root = await mkdtemp(join(tmpdir(), "det-source-ordering-"));
  const lowerCodePoint = "\uE000.md";
  const higherCodePoint = "\u{10000}.md";
  await Promise.all([
    writeFile(join(root, lowerCodePoint), "lower\n"),
    writeFile(join(root, higherCodePoint), "higher\n")
  ]);
  const manifest = await createSourceManifest([
    { namespace: "context", root, paths: [higherCodePoint, lowerCodePoint] }
  ]);
  expect(manifest.inputs.map(({ path }) => path)).toEqual([`context/${lowerCodePoint}`, `context/${higherCodePoint}`]);
});

test("source manifests normalize logical paths to NFC without changing filesystem lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "det-source-normalization-"));
  const decomposedPath = "cafe\u0301.md";
  const composedPath = decomposedPath.normalize("NFC");
  await writeFile(join(root, decomposedPath), "content\n");
  const manifest = await createSourceManifest([{ namespace: "skill", root, paths: [decomposedPath] }]);
  expect(manifest.inputs.map(({ path }) => path)).toEqual([`skill/${composedPath}`]);
  await expect(
    createSourceManifest([{ namespace: "skill", root, paths: [decomposedPath, composedPath] }])
  ).rejects.toThrow(/Duplicate selected source path/);
});
