import { readlinkSync } from "node:fs";
import { dlopen, ptr } from "bun:ffi";

/** Ask the OS about the opened object, never resolve the untrusted pathname again. Fail closed. */
export function descriptorPath(fd: number): string {
  if (process.platform === "linux") return readlinkSync(`/proc/self/fd/${fd}`);

  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      fcntl: { args: ["i32", "i32", "ptr"], returns: "i32" },
    });

    try {
      const buffer = Buffer.alloc(1024);

      // F_GETPATH resolves an open descriptor without reopening a mutable path.
      if (library.symbols.fcntl(fd, 50, ptr(buffer)) !== 0) throw new Error("Image descriptor is unavailable.");

      return buffer.subarray(0, buffer.indexOf(0)).toString();
    } finally {
      library.close();
    }
  }

  if (process.platform === "win32") return windowsDescriptorPath(fd);
  throw new Error("Secure image export is unavailable on this computer. Update Canopy.");
}

function windowsDescriptorPath(fd: number): string {
  const crt = dlopen("ucrtbase.dll", { _get_osfhandle: { args: ["i32"], returns: "i64" } });

  const kernel = dlopen("kernel32.dll", {
    GetFinalPathNameByHandleW: { args: ["i64", "ptr", "u32", "u32"], returns: "u32" },
  });

  try {
    const buffer = Buffer.alloc(65536);
    const handle = crt.symbols._get_osfhandle(fd);
    const length = kernel.symbols.GetFinalPathNameByHandleW(handle, ptr(buffer), buffer.length / 2, 0);

    if (!length || length >= buffer.length / 2) throw new Error("Image descriptor is unavailable.");
    const path = buffer.subarray(0, length * 2).toString("utf16le");

    return path.startsWith("\\\\?\\UNC\\") ? `\\\\${path.slice(8)}` : path.replace(/^\\\\\?\\/, "");
  } finally {
    kernel.close();
    crt.close();
  }
}
