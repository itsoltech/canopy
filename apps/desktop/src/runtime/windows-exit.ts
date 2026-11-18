import { dlopen, ptr } from "bun:ffi";

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

function openKernel() {
  return dlopen("kernel32.dll", {
    OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" },
    GetExitCodeProcess: { args: ["u64", "ptr"], returns: "i32" },
    CloseHandle: { args: ["u64"], returns: "i32" },
  });
}

let kernel: ReturnType<typeof openKernel> | undefined;

/** Bun v1.4.4 exposes only the low byte of the Windows exit status through ChildProcess. */
export function watchWindowsExit(pid: number | undefined) {
  if (process.platform !== "win32" || !pid) return undefined;

  try {
    const { OpenProcess, GetExitCodeProcess, CloseHandle } = (kernel ??= openKernel()).symbols;
    const handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);

    if (!handle) return undefined;

    // Read the original process object on close, even if its PID would otherwise have become reusable.
    return () => {
      try {
        const status = new Uint32Array(1);

        return GetExitCodeProcess(handle, ptr(status)) ? status[0] : undefined;
      } catch {
        return undefined;
      } finally {
        CloseHandle(handle);
      }
    };
  } catch {
    // Optional diagnostics cannot prevent the service from starting.
    return undefined;
  }
}
