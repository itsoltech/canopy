import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  statSync,
  writeFileSync,
  readFileSync,
  renameSync,
  linkSync,
} from "node:fs";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { deviceCodexHome, prepareCodexHome } from "./home.ts";

const base = tempDir("canopy-codex-home-test-");

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
    const home = prepareCodexHome({
      dataDir: mkdtempSync(join(base, "data-")),
      linkDeviceLogin: true,
      deviceCodexHome: device(false),
    });

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

  test("linked login stays fresh after CLI writes and atomic terminal replacement", () => {
    const deviceHome = device(true);

    const home = prepareCodexHome({
      dataDir: mkdtempSync(join(base, "refresh-")),
      linkDeviceLogin: true,
      deviceCodexHome: deviceHome,
    });

    writeFileSync(join(home.path, "auth.json"), "fixture-refreshed-by-worker");
    expect(readFileSync(join(deviceHome, "auth.json"), "utf8")).toBe("fixture-refreshed-by-worker");
    writeFileSync(join(deviceHome, "auth.new"), "fixture-refreshed-by-terminal");
    renameSync(join(deviceHome, "auth.new"), join(deviceHome, "auth.json"));
    expect(readFileSync(join(home.path, "auth.json"), "utf8")).toBe("fixture-refreshed-by-terminal");
  });

  test("an own login detaches a Windows-style hard link without changing the device store", () => {
    const deviceHome = device(true);
    const shadow = mkdtempSync(join(base, "hardlink-"));
    linkSync(join(deviceHome, "auth.json"), join(shadow, "auth.json"));
    writeFileSync(join(shadow, "auth.json"), "fixture-refreshed");
    expect(readFileSync(join(deviceHome, "auth.json"), "utf8")).toBe("fixture-refreshed");
    prepareCodexHome({
      dataDir: shadow,
      path: shadow,
      ownLogin: true,
      linkDeviceLogin: false,
      deviceCodexHome: deviceHome,
    });
    expect(() => lstatSync(join(shadow, "auth.json"))).toThrow();
    expect(readFileSync(join(deviceHome, "auth.json"), "utf8")).toBe("fixture-refreshed");
  });

  test("refuses to use the device home as the shadow home", () => {
    const deviceHome = device(true);

    expect(() =>
      prepareCodexHome({
        dataDir: deviceHome,
        path: deviceHome,
        linkDeviceLogin: true,
        deviceCodexHome: deviceHome,
      }),
    ).toThrow("shadow home is also the device CLI home");
    expect(readFileSync(join(deviceHome, "auth.json"), "utf8")).toBe('{"tokens":{}}');
  });

  test("protects an existing login in an isolated home", () => {
    const shadow = mkdtempSync(join(base, "existing-login-"));
    const login = join(shadow, "auth.json");
    writeFileSync(login, "fixture-own-login");

    expect(() =>
      prepareCodexHome({
        dataDir: shadow,
        path: shadow,
        linkDeviceLogin: false,
      }),
    ).toThrow("already contains a login");
    expect(readFileSync(login, "utf8")).toBe("fixture-own-login");
  });

  test("an unrelated hardlinked login remains protected when linking or selecting own login", () => {
    const shadow = mkdtempSync(join(base, "unrelated-hardlink-"));
    const source = device(true);
    const backup = join(base, `${Bun.randomUUIDv7()}.json`);
    const target = join(shadow, "auth.json");
    writeFileSync(backup, "fixture-unrelated-login");
    linkSync(backup, target);

    expect(() =>
      prepareCodexHome({ dataDir: shadow, path: shadow, deviceCodexHome: source, linkDeviceLogin: true }),
    ).toThrow("already contains a login");
    expect(readFileSync(target, "utf8")).toBe("fixture-unrelated-login");

    const own = prepareCodexHome({
      dataDir: shadow,
      path: shadow,
      deviceCodexHome: source,
      ownLogin: true,
      linkDeviceLogin: false,
    });

    expect(own.login).toBe("own");
    expect(readFileSync(target, "utf8")).toBe("fixture-unrelated-login");
    expect(statSync(target).ino).toBe(statSync(backup).ino);
    expect(readFileSync(join(source, "auth.json"), "utf8")).toBe('{"tokens":{}}');
  });

  test("a custom login source cannot expose the actual device home to shadow preparation", () => {
    const actual = device(true);
    const source = device(true);

    expect(() =>
      prepareCodexHome({
        dataDir: actual,
        path: actual,
        deviceCodexHome: source,
        protectedDeviceHome: actual,
        ownLogin: true,
        linkDeviceLogin: false,
      }),
    ).toThrow("shadow home is also the device CLI home");
    expect(readFileSync(join(actual, "auth.json"), "utf8")).toBe('{"tokens":{}}');
  });
});
