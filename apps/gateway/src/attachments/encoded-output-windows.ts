import { dlopen, ptr } from "bun:ffi";
import type { Sharp } from "sharp";
import type { AttachmentRejected } from "./rejected.ts";

const native = () =>
  dlopen("kernel32.dll", {
    CreateFileW: { args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    LockFileEx: { args: ["u64", "u32", "u32", "u32", "u32", "ptr"], returns: "i32" },
    GetFileSizeEx: { args: ["u64", "ptr"], returns: "i32" },
    ReadFile: { args: ["u64", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });

let library: ReturnType<typeof native> | undefined;

/** Windows byte-range locks are mandatory across handles, including the encoder's file target. */
export async function windowsEncodedOutput(
  image: Sharp,
  path: string,
  maxBytes: number,
  rejected: () => AttachmentRejected,
) {
  const { symbols } = (library ??= native());
  const encodedPath = Buffer.from(`${path}\0`, "utf16le");
  // Use CREATE_NEW and share reads and writes. A Bun fd is not valid in a separate CRT.
  const handle = symbols.CreateFileW(ptr(encodedPath), 0xc0000000, 3, null, 1, 0x80, 0n);

  if (handle === 0xffffffffffffffffn) throw rejected();

  try {
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

    const size = Buffer.alloc(8);

    if (!symbols.GetFileSizeEx(handle, ptr(size))) throw rejected();
    const length = Number(size.readBigUInt64LE());

    if (!length || length > maxBytes) throw rejected();
    const data = Buffer.alloc(length);
    const count = Buffer.alloc(4);

    // Reading by path can request a larger range than the file and collide with the lock past its end.
    if (!symbols.ReadFile(handle, ptr(data), length, ptr(count), null) || count.readUInt32LE() !== length)
      throw rejected();

    return { data, info };
  } finally {
    symbols.CloseHandle(handle); // Releases the lock as well, including on encoder failure.
  }
}
