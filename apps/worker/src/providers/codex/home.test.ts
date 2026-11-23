import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  writeFileSync,
  readFileSync,
  renameSync,
  linkSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { deviceCodexHome, prepareCodexHome } from "./home.ts";
import { removeLegacyCodexHardLinks } from "./legacy-login.ts";

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

    if (process.platform !== "win32") expect(statSync(home.path).mode & 0o777).toBe(0o700);

    expect(lstatSync(join(home.path, "auth.json")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(home.path, "auth.json"))).toBe(realpathSync(join(deviceHome, "auth.json")));
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
    expect(deviceCodexHome({}, "/home/u")).toBe(join("/home/u", ".codex"));
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

  test("migrates a live hard link before either CLI replaces its credentials", () => {
    const dataDir = mkdtempSync(join(base, "live-link-"));
    const deviceHome = device(true);
    const source = join(deviceHome, "auth.json");
    const shadow = join(dataDir, "codex-home");
    const target = join(shadow, "auth.json");
    mkdirSync(shadow);
    linkSync(source, target);

    expect(prepareCodexHome({ dataDir, deviceCodexHome: deviceHome, linkDeviceLogin: true }, "win32").login).toBe(
      "linked",
    );
    expect(statSync(source).nlink).toBe(1);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readdirSync(shadow)).toEqual(["auth.json"]);
    expect(readFileSync(source, "utf8")).toBe('{"tokens":{}}');
  });

  test("a replaced device login recovers the managed thread home and preserves the old file", () => {
    const dataDir = mkdtempSync(join(base, "orphan-link-"));
    const deviceHome = device(true);
    const source = join(deviceHome, "auth.json");
    const shadow = join(dataDir, "codex-home");
    const target = join(shadow, "auth.json");
    mkdirSync(shadow);
    linkSync(source, target);
    linkSync(source, join(dataDir, "previous-login"));
    writeFileSync(join(deviceHome, "auth.new"), "current-login");
    renameSync(join(deviceHome, "auth.new"), source);
    const options = { dataDir, deviceCodexHome: deviceHome, linkDeviceLogin: true };

    expect(prepareCodexHome(options, "win32").login).toBe("linked");
    expect(prepareCodexHome(options, "win32").login).toBe("linked");
    expect(readFileSync(target, "utf8")).toBe("current-login");
    const backups = readdirSync(shadow).filter((name) => name.startsWith("auth.json.canopy-backup-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(shadow, backups[0]!), "utf8")).toBe('{"tokens":{}}');
    expect(readFileSync(join(dataDir, "previous-login"), "utf8")).toBe('{"tokens":{}}');
  });

  test("migrates inactive homes and keeps device and independent logins intact", () => {
    const dataDir = mkdtempSync(join(base, "inactive-"));
    const sourceHome = device(true);
    const source = join(sourceHome, "auth.json");
    const ownHome = join(dataDir, "homes", "codex-own");
    const botHome = join(dataDir, "bots", "bot", "conversations", "conversation", "instance", "home");
    const privateBot = join(dataDir, "bots", "bot", "own-instance", "home");
    const custom = mkdtempSync(join(base, "custom-shadow-"));
    const worktree = join(dataDir, "worktrees", "project");

    for (const home of [ownHome, botHome, privateBot, worktree]) mkdirSync(home, { recursive: true });
    const ownAuth = join(ownHome, "auth.json");
    writeFileSync(ownAuth, "own-login");
    writeFileSync(join(worktree, "auth.json"), "project-file");
    linkSync(source, join(botHome, "auth.json"));
    linkSync(source, join(custom, "auth.json"));
    linkSync(ownAuth, join(privateBot, "auth.json"));
    const aliasedSource = join(dataDir, "homes", "codex-source-alias");
    symlinkSync(sourceHome, aliasedSource, "junction");

    removeLegacyCodexHardLinks(dataDir, [sourceHome, ownHome], [custom, aliasedSource], "win32");

    for (const home of [botHome, privateBot, custom])
      expect(lstatSync(join(home, "auth.json"), { throwIfNoEntry: false })).toBeUndefined();
    expect(statSync(source).nlink).toBe(1);
    expect(readFileSync(source, "utf8")).toBe('{"tokens":{}}');
    expect(statSync(ownAuth).nlink).toBe(1);
    expect(readFileSync(ownAuth, "utf8")).toBe("own-login");
    expect(readFileSync(join(worktree, "auth.json"), "utf8")).toBe("project-file");
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
