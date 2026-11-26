import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
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
import { Provider } from "@canopy/contracts";
import { botSessionInstanceKey } from "../../bots/session.ts";
import { migrateCodexLogins } from "../../runtime/codex-login-migration.ts";
import { deviceCodexHome, prepareCodexHome, prepareCodexInstanceHome } from "./home.ts";

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

  test.skipIf(process.getuid?.() === 0)("Windows link denial leaves the device login usable by the CLI", () => {
    const dataDir = mkdtempSync(join(base, "denied-"));
    const path = join(dataDir, "codex-home");
    const deviceHome = device(true);
    mkdirSync(path);
    const windows = process.platform === "win32";

    // Deny file creation only inside this test home, including on privileged Windows CI runners.
    if (windows) execFileSync("icacls", [path, "/deny", "*S-1-1-0:(WD)"]);
    else chmodSync(path, 0o500);

    try {
      const denied = prepareCodexHome({ dataDir, deviceCodexHome: deviceHome, linkDeviceLogin: true }, "win32");
      expect(denied.linkFailed).toBe(true);
      expect(denied.problem).toContain("Use CLI home");

      const direct = prepareCodexInstanceHome(
        { id: "native", kind: "native" },
        { dataDir, path, deviceHome, linkDeviceLogin: true },
      );

      expect(direct).toEqual({ path: deviceHome, login: "cli" });
      expect(lstatSync(join(path, "auth.json"), { throwIfNoEntry: false })).toBeUndefined();
      expect(readFileSync(join(deviceHome, "auth.json"), "utf8")).toBe('{"tokens":{}}');
    } finally {
      if (windows) execFileSync("icacls", [path, "/remove:d", "*S-1-1-0"]);
      else chmodSync(path, 0o700);
    }
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

  test("a running shadow keeps its link through a terminal sign-out and new sign-in", () => {
    const deviceHome = device(true);

    const options = {
      dataDir: mkdtempSync(join(base, "relogin-")),
      deviceCodexHome: deviceHome,
      linkDeviceLogin: true,
    };

    const home = prepareCodexHome(options);
    const source = join(deviceHome, "auth.json");
    const target = join(home.path, "auth.json");
    renameSync(source, join(deviceHome, "previous"));
    expect(prepareCodexHome(options).login).toBe("none");
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    writeFileSync(source, "new-login");
    expect(readFileSync(target, "utf8")).toBe("new-login");
  });

  test("the instance and nested consumers share the CLI write lock until own login is selected", () => {
    const deviceHome = device(true);
    const dataDir = mkdtempSync(join(base, "lock-"));
    const path = join(dataDir, "codex-home");
    const lock = join(path, "auth.lock");
    const source = join(deviceHome, "auth.lock");
    mkdirSync(path);
    writeFileSync(lock, "");
    const options = { dataDir, deviceCodexHome: deviceHome, linkDeviceLogin: true };
    prepareCodexHome(options);
    writeFileSync(source, "");
    const nested = prepareCodexHome({ ...options, deviceCodexHome: path, path: join(dataDir, "child") });
    expect(realpathSync(join(nested.path, "auth.lock"))).toBe(realpathSync(source));
    expect(realpathSync(lock)).toBe(realpathSync(source));
    prepareCodexHome({ ...options, ownLogin: true });
    expect(lstatSync(lock, { throwIfNoEntry: false })).toBeUndefined();
    expect(statSync(source).isFile()).toBe(true);
  });

  test("a conflicting file at the lock path survives a failed link and the next attempt can recover", () => {
    const dataDir = mkdtempSync(join(base, "conflicting-lock-"));
    const deviceHome = device(true);
    const path = join(dataDir, "codex-home");
    mkdirSync(path);
    const lock = join(path, "auth.lock");
    writeFileSync(lock, "independent file");
    const options = { dataDir, deviceCodexHome: deviceHome, linkDeviceLogin: true };
    expect(prepareCodexHome(options).linkFailed).toBe(true);
    expect(readFileSync(lock, "utf8")).toBe("independent file");
    renameSync(lock, join(path, "saved"));
    expect(prepareCodexHome(options).login).toBe("linked");
    expect(lstatSync(lock).isSymbolicLink()).toBe(true);
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
    expect(readdirSync(shadow).sort()).toEqual(["auth.json", "auth.lock"]);
    expect(readFileSync(source, "utf8")).toBe('{"tokens":{}}');
  });

  test.skipIf(process.getuid?.() === 0)("keeps a thread's live hard link if Windows denies the replacement", () => {
    const dataDir = mkdtempSync(join(base, "denied-migration-"));
    const deviceHome = device(true);
    const source = join(deviceHome, "auth.json");
    const path = join(dataDir, "codex-home");
    const target = join(path, "auth.json");

    const config = {
      codex: { enabled: true, linkDeviceLogin: true },
      profiles: [{ config: { id: "isolated", kind: "native" as const } }],
    };

    mkdirSync(path, { recursive: true });
    linkSync(source, target);
    const windows = process.platform === "win32";

    if (windows) execFileSync("icacls", [path, "/deny", "*S-1-1-0:(WD)"]);
    else chmodSync(path, 0o500);

    try {
      migrateCodexLogins(config, dataDir, deviceHome, "win32");
      const denied = prepareCodexHome({ dataDir, path, deviceCodexHome: deviceHome, linkDeviceLogin: true }, "win32");

      expect(denied.linkFailed).toBe(true);
      expect(denied.problem).toContain("Windows could not link the Codex login.");
      expect(lstatSync(target).isFile()).toBe(true);
      expect(statSync(target, { bigint: true }).ino).toBe(statSync(source, { bigint: true }).ino);
      expect(statSync(source).nlink).toBe(2);
      expect(readdirSync(path)).toEqual(["auth.json"]);
    } finally {
      if (windows) execFileSync("icacls", [path, "/remove:d", "*S-1-1-0"]);
      else chmodSync(path, 0o700);
    }

    migrateCodexLogins(config, dataDir, deviceHome, "win32");
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(path, "auth.lock")).isSymbolicLink()).toBe(true);
    expect(statSync(source).nlink).toBe(1);
  });

  test("keeps the active hard link when the thread's shared write lock cannot be installed", () => {
    const dataDir = mkdtempSync(join(base, "blocked-migration-"));
    const deviceHome = device(true);
    const source = join(deviceHome, "auth.json");
    const path = join(dataDir, "codex-home");
    const target = join(path, "auth.json");
    const lock = join(path, "auth.lock");
    mkdirSync(path, { recursive: true });
    linkSync(source, target);
    writeFileSync(lock, "independent file");

    migrateCodexLogins(
      { codex: { enabled: true, linkDeviceLogin: true }, profiles: [{ config: { id: "isolated", kind: "native" } }] },
      dataDir,
      deviceHome,
      "win32",
    );

    expect(lstatSync(target).isFile()).toBe(true);
    expect(statSync(source).nlink).toBe(2);
    expect(readFileSync(lock, "utf8")).toBe("independent file");
    expect(readdirSync(path).sort()).toEqual(["auth.json", "auth.lock"]);
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

    expect(prepareCodexHome(options).login).toBe("linked");
    expect(prepareCodexHome(options).login).toBe("linked");
    expect(readFileSync(target, "utf8")).toBe("current-login");
    const backups = readdirSync(shadow).filter((name) => name.startsWith("auth.json.canopy-backup-"));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(shadow, backups[0]!), "utf8")).toBe('{"tokens":{}}');
    expect(readFileSync(join(dataDir, "previous-login"), "utf8")).toBe('{"tokens":{}}');
  });

  test("detaches known bot links and keeps the thread login migration intact", () => {
    const dataDir = mkdtempSync(join(base, "inactive-"));
    const sourceHome = device(true);
    const source = join(sourceHome, "auth.json");
    const ownHome = join(dataDir, "homes", "codex-own");
    const nativeKey = botSessionInstanceKey(Provider.CODEX, "native");
    const ownKey = botSessionInstanceKey(Provider.CODEX, "own");
    const botHome = join(dataDir, "bots", "bot", "conversations", "conversation", nativeKey, "home");
    const privateBot = join(dataDir, "bots", "bot", ownKey, "home");
    const inactive = join(dataDir, "bots", "bot", botSessionInstanceKey(Provider.CODEX, "inactive"), "home");
    const custom = mkdtempSync(join(base, "custom-shadow-"));
    const worktree = join(dataDir, "worktrees", "project");

    for (const home of [ownHome, botHome, privateBot, inactive, worktree]) mkdirSync(home, { recursive: true });
    const ownAuth = join(ownHome, "auth.json");
    writeFileSync(ownAuth, "own-login");
    writeFileSync(join(worktree, "auth.json"), "project-file");
    linkSync(source, join(botHome, "auth.json"));
    linkSync(source, join(custom, "auth.json"));
    linkSync(source, join(inactive, "auth.json"));
    linkSync(ownAuth, join(privateBot, "auth.json"));
    symlinkSync(join(sourceHome, "auth.lock"), join(botHome, "auth.lock"), "file");
    writeFileSync(join(privateBot, "auth.lock"), "private-lock");
    const aliasedSource = join(dataDir, "homes", "codex-source-alias");
    symlinkSync(sourceHome, aliasedSource, "junction");

    migrateCodexLogins(
      {
        codex: { enabled: true, linkDeviceLogin: true },
        profiles: [
          { config: { kind: "native", id: "native" } },
          { config: { kind: "native", id: "custom", runtime: { shadowHomePath: custom } } },
          { config: { kind: "native", id: "own", runtime: { ownLogin: true } } },
          { config: { kind: "native", id: "alias", runtime: { shadowHomePath: aliasedSource } } },
        ],
      },
      dataDir,
      sourceHome,
      "win32",
    );

    expect(readdirSync(botHome)).toEqual([]);
    expect(readdirSync(inactive)).toEqual([]);
    expect(readdirSync(privateBot)).toEqual(["auth.lock"]);
    expect(readFileSync(join(privateBot, "auth.lock"), "utf8")).toBe("private-lock");
    expect(lstatSync(join(custom, "auth.json")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(custom, "auth.lock")).isSymbolicLink()).toBe(true);
    expect(statSync(source).nlink).toBe(1);
    expect(readFileSync(source, "utf8")).toBe('{"tokens":{}}');
    expect(statSync(ownAuth).nlink).toBe(1);
    expect(readFileSync(ownAuth, "utf8")).toBe("own-login");
    expect(readFileSync(join(worktree, "auth.json"), "utf8")).toBe("project-file");
  });

  test("cleans inactive bot symlinks without a current device credential file", () => {
    const canonical = mkdtempSync(join(base, "inactive-symlinks-"));
    const dataDir = canonical + "-alias";
    symlinkSync(canonical, dataDir, "junction");
    const sourceHome = device(false);
    const ownHome = join(dataDir, "homes", "codex-removed");
    const ownLogin = join(ownHome, "auth.json");
    const bot = join(dataDir, "bots", "bot");
    const native = join(bot, botSessionInstanceKey(Provider.CODEX, "native"), "home");
    const removed = join(bot, botSessionInstanceKey(Provider.CODEX, "removed"), "home");
    const unrelated = join(dataDir, "unrelated-login");
    const external = device(true);
    const linked = join(bot, botSessionInstanceKey(Provider.CODEX, "junction"), "home");

    for (const home of [ownHome, native, removed, join(linked, "..")]) mkdirSync(home, { recursive: true });
    writeFileSync(ownLogin, "fixture-own-login");
    writeFileSync(unrelated, "fixture-unrelated-login");
    symlinkSync(join(sourceHome, "auth.json"), join(native, "auth.json"), "file");
    symlinkSync(join(sourceHome, "auth.lock"), join(native, "auth.lock"), "file");
    symlinkSync(ownLogin, join(removed, "auth.json"), "file");
    linkSync(unrelated, join(removed, "auth.lock"));
    symlinkSync(join(sourceHome, "auth.lock"), join(external, "auth.lock"), "file");
    symlinkSync(external, linked, "junction");

    migrateCodexLogins(
      { codex: { enabled: true, linkDeviceLogin: false }, profiles: [] },
      dataDir,
      sourceHome,
      "linux",
    );

    expect(readdirSync(native)).toEqual([]);
    expect(readdirSync(removed)).toEqual(["auth.lock"]);
    expect(statSync(unrelated).nlink).toBe(2);
    expect(readFileSync(ownLogin, "utf8")).toBe("fixture-own-login");
    expect(lstatSync(join(external, "auth.lock")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(external, "auth.json"), "utf8")).toBe('{"tokens":{}}');
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

  test("a source symlink into the shadow protects the original login even with another hard link", () => {
    const source = device(false);
    const shadow = mkdtempSync(join(base, "source-alias-"));
    const login = join(shadow, "auth.json");
    writeFileSync(login, "fixture-login");
    const alias = join(shadow, "previous-login");
    linkSync(login, alias);
    const alternateCase = join(shadow, "AUTH.json");
    const sourceLogin = lstatSync(alternateCase, { throwIfNoEntry: false }) ? alternateCase : login;
    symlinkSync(sourceLogin, join(source, "auth.json"), "file");

    expect(() =>
      prepareCodexHome({ dataDir: shadow, path: shadow, deviceCodexHome: source, linkDeviceLogin: true }),
    ).toThrow("The shadow home contains the device login.");
    expect(readFileSync(login, "utf8")).toBe("fixture-login");
    expect(statSync(alias).nlink).toBe(2);
  });
});
