import type { FileHandle } from "node:fs/promises";
import { readBoundedFileHandle } from "../packages/skills-autoresearch/src/bounded-file.js";

type FileMetadata = Awaited<ReturnType<FileHandle["stat"]>>;

function metadata(size: number): FileMetadata {
  return { dev: 1, ino: 2, size, isFile: () => true } as FileMetadata;
}

test("bounded descriptor reads accumulate short reads until EOF", async () => {
  const source = Buffer.from("short reads");
  const openedMetadata = metadata(source.length);
  const handle = {
    async read(buffer: Buffer, offset: number, length: number, position: number) {
      const bytesRead = Math.min(2, length, source.length - position);
      if (bytesRead > 0) source.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead, buffer };
    },
    async stat() {
      return openedMetadata;
    }
  } as Pick<FileHandle, "read" | "stat">;

  await expect(
    readBoundedFileHandle(handle, openedMetadata, 32, {
      changed: () => new Error("changed"),
      oversized: () => new Error("oversized")
    })
  ).resolves.toEqual(source);
});

test("bounded descriptor reads reject same-inode growth during the read window", async () => {
  const source = Buffer.from("safe");
  const openedMetadata = metadata(source.length);
  const handle = {
    async read(buffer: Buffer, offset: number, length: number, position: number) {
      const bytesRead = Math.min(length, source.length - position);
      if (bytesRead > 0) source.copy(buffer, offset, position, position + bytesRead);
      return { bytesRead, buffer };
    },
    async stat() {
      return metadata(source.length + 1);
    }
  } as Pick<FileHandle, "read" | "stat">;

  await expect(
    readBoundedFileHandle(handle, openedMetadata, 32, {
      changed: () => new Error("changed"),
      oversized: () => new Error("oversized")
    })
  ).rejects.toThrow("changed");
});
