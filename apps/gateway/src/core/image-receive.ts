import { createHash } from "node:crypto";
import type { ThreadImageExport } from "@canopy/contracts";
import { IMAGE_REPLY_LIMITS } from "@canopy/domain/image-replies";
import { Invalid } from "../store/store.ts";

/** Metadata is checked before allocation, and every bounded chunk is tied to the same immutable export. */
export async function receiveThreadImage(
  query: (operation: string, offset: bigint) => Promise<ThreadImageExport>,
  maxBytes: number,
  deadline: number,
) {
  try {
    const meta = await query("probe", 0n);
    const size = Number(meta.sizeBytes);

    if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes || meta.data.length !== 0)
      throw new Invalid("This image exceeds the remaining image limit. Choose a smaller image.");
    const data = Buffer.alloc(size);
    let offset = 0;
    let digest = "";

    while (offset < size) {
      if (Date.now() >= deadline) throw new Invalid("The image transfer expired. Try again.");
      const chunk = await query("read", BigInt(offset));

      if (
        chunk.sizeBytes !== meta.sizeBytes ||
        chunk.name !== meta.name ||
        !/^[a-f0-9]{64}$/.test(chunk.sha256) ||
        (digest && digest !== chunk.sha256) ||
        chunk.data.length === 0 ||
        chunk.data.length > IMAGE_REPLY_LIMITS.chunkBytes ||
        offset + chunk.data.length > size
      )
        throw new Invalid("The image changed during transfer. Try again.");
      digest = chunk.sha256;
      data.set(chunk.data, offset);
      offset += chunk.data.length;
    }

    if (createHash("sha256").update(data).digest("hex") !== digest)
      throw new Invalid("The image transfer was incomplete. Try again.");

    return { name: meta.name, data };
  } finally {
    await query("release", 0n).catch(() => undefined);
  }
}
