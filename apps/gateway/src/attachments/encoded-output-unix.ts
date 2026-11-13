import { dlopen, ptr } from "bun:ffi";
import { closeSync, constants, openSync, readSync } from "node:fs";
import type { Sharp } from "sharp";
import type { AttachmentRejected } from "./rejected.ts";

const native = () =>
  dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {
    mkfifo: { args: ["cstring", "u32"], returns: "i32" },
    poll: { args: ["ptr", "u64", "i32"], returns: "i32" },
  });

let library: ReturnType<typeof native> | undefined;

/** The encoder writes into a bounded OS pipe, never a full native output buffer or an unbounded disk file. */
export async function unixEncodedOutput(
  image: Sharp,
  path: string,
  maxBytes: number,
  rejected: () => AttachmentRejected,
) {
  if (!["linux", "darwin"].includes(process.platform)) throw rejected();
  const { symbols } = (library ??= native());

  if (symbols.mkfifo(Buffer.from(`${path}\0`), 0o600) !== 0) throw rejected();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  const descriptor = Buffer.alloc(8);
  descriptor.writeInt32LE(fd);
  descriptor.writeInt16LE(1, 4); // POLLIN only; one reader, so a ready read cannot race another consumer.
  const buffer = Buffer.alloc(64 * 1024);
  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;
  let complete = false;

  const encoding = image
    .timeout({ seconds: 30 })
    .toFile(path)
    .then(
      (info) => info,
      () => undefined,
    )
    .finally(() => {
      complete = true;
    });

  try {
    while (true) {
      const ready = symbols.poll(ptr(descriptor), 1n, 0);

      if (ready < 0) throw rejected();

      if (descriptor.readInt16LE(6) & 1) {
        const count = readSync(fd, buffer, 0, buffer.length, null);

        if (count > maxBytes - total) {
          exceeded = true;
          chunks.length = 0;
        }

        if (count && !exceeded) {
          chunks.push(Buffer.from(buffer.subarray(0, count)));
          total += count;
        }
      } else if (complete) break;
      else await Bun.sleep(1);
    }

    const info = await encoding;

    if (exceeded) throw rejected();

    if (!info) throw new Error("The image encoder could not write the image.");

    return { data: Buffer.concat(chunks, total), info };
  } finally {
    // libvips can open the FIFO read/write. Drain rejected output too, so its writer cannot deadlock on itself.
    closeSync(fd);
    await encoding;
  }
}
