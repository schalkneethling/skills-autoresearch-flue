import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSourceManifestCurrent,
  createSourceManifest,
  serializeSourceManifest
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
  expect(await readFile(outside, "utf8")).toBe("outside");
});
