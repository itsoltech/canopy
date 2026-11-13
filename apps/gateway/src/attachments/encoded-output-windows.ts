import { dlopen, ptr } from "bun:ffi";
import { closeSync, constants, openSync, readFileSync, statSync } from "node:fs";
import type { Sharp } from "sharp";
import type { AttachmentRejected } from "./rejected.ts";

const native = () =>
  dlopen("kernel32.dll", {
    LockFileEx: { args: ["i64", "u32", "u32", "u32", "u32", "ptr"], returns: "i32" },
  });

const openCrt = () => dlopen("ucrtbase.dll", { _get_osfhandle: { args: ["i32"], returns: "i64" } });

let library: ReturnType<typeof native> | undefined;
let crt: ReturnType<typeof openCrt> | undefined;

/** Windows byte-range locks are mandatory across handles, including the encoder's file target. */
export async function windowsEncodedOutput(
  image: Sharp,
  path: string,
  maxBytes: number,
  rejected: () => AttachmentRejected,
) {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);

  try {
    const { symbols } = (library ??= native());
    const handle = (crt ??= openCrt()).symbols._get_osfhandle(fd);
    const overlap = Buffer.alloc(32);
    overlap.writeUInt32LE(maxBytes, 16);

    // FAIL_IMMEDIATELY | EXCLUSIVE_LOCK: bytes at/above the limit cannot be written by the native encoder.
    if (!symbols.LockFileEx(handle, 3, 0, 0xffffffff, 0x7fffffff, ptr(overlap))) throw rejected();

    const info = await image
      .timeout({ seconds: 30 })
      .toFile(path)
      .catch(() => {
        throw rejected();
      });

    if (statSync(path).size > maxBytes) throw rejected();

    return { data: readFileSync(path), info };
  } finally {
    closeSync(fd); // Releases the lock as well, including on encoder failure.
  }
}
