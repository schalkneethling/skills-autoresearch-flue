import type { FileHandle } from "node:fs/promises";

type FileMetadata = Awaited<ReturnType<FileHandle["stat"]>>;

export async function readBoundedFileHandle(
  handle: Pick<FileHandle, "read" | "stat">,
  openedMetadata: FileMetadata,
  limit: number,
  errors: { changed: () => Error; oversized: () => Error }
): Promise<Buffer> {
  const buffer = Buffer.alloc(limit + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > limit) throw errors.oversized();
  const finalMetadata = await handle.stat();
  if (
    !finalMetadata.isFile() ||
    finalMetadata.dev !== openedMetadata.dev ||
    finalMetadata.ino !== openedMetadata.ino ||
    finalMetadata.size !== openedMetadata.size ||
    finalMetadata.size > limit
  ) {
    throw errors.changed();
  }
  return buffer.subarray(0, offset);
}
