import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { serviceSnippet } from "@canopy/updater";

// Opt-in on Linux with a cgroup v2 memory controller delegated to the systemd user manager.
test.skipIf(process.platform !== "linux" || process.env["CANOPY_LIVE"] !== "1")(
  "a workload OOM kills its process tree while the worker and sibling can finish",
  async () => {
    const unit = serviceSnippet("worker", "linux", process.execPath, []);
    const properties = unit.match(/^(?:Delegate|DelegateSubgroup|OOMPolicy|KillMode)=.+$/gm) ?? [];

    const testService = Bun.spawn(
      [
        "systemd-run",
        "--user",
        "--quiet",
        "--wait",
        "--collect",
        "--pipe",
        "--same-dir",
        "--slice=canopytest.slice",
        `--unit=canopy-test-workload-${randomUUID()}`,
        ...properties.map((value) => `--property=${value}`),
        "--property=MemoryMax=256M",
        "--property=MemorySwapMax=0",
        "--property=RuntimeMaxSec=25s",
        "--",
        process.execPath,
        join(import.meta.dir, "fixtures/workload-memory.ts"),
      ],
      { stdout: "inherit", stderr: "inherit" },
    );

    expect(await testService.exited).toBe(0);
  },
  35_000,
);
