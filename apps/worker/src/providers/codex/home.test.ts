import { afterAll, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceCodexHome, prepareCodexHome } from "./home.ts";

const base = mkdtempSync(join(tmpdir(), "oa-codex-home-test-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

function device(withLogin: boolean): string {
  const dir = mkdtempSync(join(base, "device-"));
  if (withLogin) writeFileSync(join(dir, "auth.json"), '{"tokens":{}}');
  mkdirSync(join(dir, "plugins"), { recursive: true }); // must never reach the worker home
  return dir;
}

describe("prepareCodexHome", () => {
  test("isolated home under the data dir with the device login linked (default)", () => {
    const dataDir = mkdtempSync(join(base, "data-"));
    const deviceHome = device(true);
    const home = prepareCodexHome({ dataDir, linkDeviceLogin: true, deviceCodexHome: deviceHome });
    expect(home).toEqual({ path: join(dataDir, "codex-home"), login: "linked" });
    expect(statSync(home.path).mode & 0o777).toBe(0o700);
    expect(readlinkSync(join(home.path, "auth.json"))).toBe(join(deviceHome, "auth.json"));
    expect(() => lstatSync(join(home.path, "plugins"))).toThrow();
    // Idempotent on restart.
    expect(prepareCodexHome({ dataDir, linkDeviceLogin: true, deviceCodexHome: deviceHome }).login).toBe("linked");
  });

  test("no device login: home still prepared, problem reported", () => {
    const home = prepareCodexHome({ dataDir: mkdtempSync(join(base, "data-")), linkDeviceLogin: true, deviceCodexHome: device(false) });
    expect(home.login).toBe("none");
    expect(home.problem).toContain("codex login");
  });

  test("CLIProxyAPI-only workers: the link is removed when turned off", () => {
    const dataDir = mkdtempSync(join(base, "data-"));
    const deviceHome = device(true);
    prepareCodexHome({ dataDir, linkDeviceLogin: true, deviceCodexHome: deviceHome });
    const home = prepareCodexHome({ dataDir, linkDeviceLogin: false, deviceCodexHome: deviceHome });
    expect(home).toEqual({ path: join(dataDir, "codex-home"), login: "none" });
    expect(() => lstatSync(join(home.path, "auth.json"))).toThrow();
  });

  test("device Codex home: $CODEX_HOME or ~/.codex", () => {
    expect(deviceCodexHome({ CODEX_HOME: "/opt/codex" }, "/home/u")).toBe("/opt/codex");
    expect(deviceCodexHome({}, "/home/u")).toBe("/home/u/.codex");
  });
});
