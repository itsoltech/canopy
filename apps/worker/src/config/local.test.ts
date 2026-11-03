import { describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { Result } from "effect";
import { defaultConfigPath, defaultDataDir, loadLocalConfig, parseLocalConfig } from "./local.ts";

const VALID = {
  gateway_url: "https://agents.example.com",
  worker_id: "0196f0c1-0000-7000-8000-000000000001",
  credential: "c".repeat(32),
};
const dir = tempDir("oa-local-config-");

describe("local worker config (connection only)", () => {
  test("accepts the connection settings and nothing else", () => {
    const ok = parseLocalConfig(JSON.stringify({ ...VALID, ca_file: "/etc/oa/ca.pem", ping_interval_seconds: 20 }));
    expect(Result.isSuccess(ok) && ok.success.ping_interval_seconds).toBe(20);
    // Remote settings do not belong here: unknown keys are errors, not silently ignored.
    const extra = parseLocalConfig(JSON.stringify({ ...VALID, providers: [] }));
    expect(Result.isFailure(extra) && extra.failure).toContain("providers");
    expect(Result.isSuccess(parseLocalConfig(JSON.stringify({ ...VALID, allowedRoots: ["missing"], allowed_roots: [] })))).toBe(true);
  });

  test("rejects bad values and invalid JSON", () => {
    for (const bad of [
      { ...VALID, gateway_url: "ftp://x" },
      { ...VALID, worker_id: "w1" },
      { ...VALID, credential: "short" },
      { ...VALID, ping_interval_seconds: 1 },
    ]) {
      expect(Result.isFailure(parseLocalConfig(JSON.stringify(bad)))).toBe(true);
    }
    expect(Result.isFailure(parseLocalConfig("{"))).toBe(true);
  });

  test.skipIf(process.platform === "win32")("refuses a credential file readable by other users", async () => {
    const path = join(dir, "worker.json");
    writeFileSync(path, JSON.stringify(VALID));
    chmodSync(path, 0o644);
    const open = await loadLocalConfig(path, process.platform);
    expect(Result.isFailure(open) && open.failure).toContain("chmod 600");
    chmodSync(path, 0o600);
    expect(Result.isSuccess(await loadLocalConfig(path, process.platform))).toBe(true);
    expect(Result.isFailure(await loadLocalConfig(join(dir, "missing.json"), process.platform))).toBe(true);
  });

  test("per-OS default locations, overridable", () => {
    expect(defaultConfigPath({}, "linux", "/home/u")).toBe("/home/u/.config/open-agents/worker.json");
    expect(defaultConfigPath({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/u")).toBe("/x/open-agents/worker.json");
    expect(defaultConfigPath({}, "darwin", "/Users/u")).toBe("/Users/u/Library/Application Support/open-agents/worker.json");
    expect(defaultConfigPath({ APPDATA: "C:/Users/u/AppData/Roaming" }, "win32")).toBe(join("C:/Users/u/AppData/Roaming", "open-agents", "worker.json"));
    expect(defaultConfigPath({ OA_WORKER_CONFIG: "/etc/oa/worker.json" }, "linux")).toBe("/etc/oa/worker.json");
    expect(defaultDataDir({}, "linux", "/home/u")).toBe("/home/u/.local/share/open-agents");
  });
});
