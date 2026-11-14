import { readlinkSync } from "node:fs";
import { dlopen, ptr } from "bun:ffi";

/** Ask the OS about the opened object, never resolve the untrusted pathname again. Fail closed. */
export function descriptorPath(fd: number): string {
  if (process.platform === "linux") return readlinkSync(`/proc/self/fd/${fd}`);

  if (process.platform === "darwin") {
    // fcntl is variadic. On Apple arm64, variadic arguments are read from the stack, never from registers: a
    // three-argument call left F_GETPATH a stale stack word, so it wrote the path into the worker's JS heap and
    // crashed it. Nine arguments fill x0-x7 and the first stack slot; x86-64 reads the pointer from the third.
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      fcntl: { args: ["i32", "i32", "ptr", "ptr", "ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
    });

    try {
      const buffer = Buffer.alloc(1024);
      const target = ptr(buffer);

      // F_GETPATH resolves an open descriptor without reopening a mutable path.
      if (library.symbols.fcntl(fd, 50, target, target, target, target, target, target, target) !== 0)
        throw new Error("Image descriptor is unavailable.");
      const path = buffer.subarray(0, buffer.indexOf(0)).toString();

      if (!path.startsWith("/")) throw new Error("Image descriptor is unavailable.");

      return path;
    } finally {
      library.close();
    }
  }

  // Windows keeps the HANDLE instead (export-root-windows.ts).
  throw new Error("Secure image export is unavailable on this computer. Update Canopy.");
}
