import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  DeviceLogin,
  Provider,
  ProviderConfigurationMode,
  ProviderProfileKind,
  WorkerConfigSchema,
} from "@canopy/contracts";
import { tempDir, tempDirs } from "@canopy/testing";
import { applyWorkerConfig, systemProbe, type DeviceProbe } from "./remote.ts";
import { Predicate } from "effect";

const base = tempDir("canopy-remote-config-");
const profileDir = tempDirs();
const repo = join(base, "repo");

mkdirSync(join(repo, "sub"), { recursive: true });

symlinkSync(repo, join(base, "link"));

/** Real filesystem, fake CLIs: claude 2.3.1 and codex 0.164.0 installed. */
const probe: DeviceProbe = {
  which: (command) => (command === "claude" || command === "codex" ? `/usr/bin/${command}` : null),
  version: (executable) => (executable.endsWith("claude") ? "2.3.1 (Claude Code)" : "codex-cli 0.164.0"),
  realDirectory: systemProbe.realDirectory,
};

type ConfigInit = MessageInitShape<typeof WorkerConfigSchema>;

const config = (init: Omit<ConfigInit, "version"> = {}) =>
  create(WorkerConfigSchema, {
    version: 7n,
    allowedRoots: [repo],
    claude: { enabled: true },
    codex: { enabled: true },
    ...init,
  } as ConfigInit);

describe("applyWorkerConfig", () => {
  test("applies a valid configuration and reports providers and profiles without secrets", () => {
    const result = applyWorkerConfig(
      config({
        profiles: [
          { id: "proxy", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:8317", apiKey: "sk-secret" },
        ],
        limits: { maxRunningTurns: 2 },
        nativeTools: { subagents: true },
      }),
      probe,
    );

    if (!result.applied) throw new Error("expected applied");
    expect(result.config.claude).toEqual({
      enabled: true,
      linkDeviceLogin: true,
      executable: "/usr/bin/claude",
      version: "2.3.1",
    });
    expect(result.config.limits.maxRunningTurns).toBe(2);
    expect(result.config.limits.drainTimeoutSeconds).toBe(600); // default when unset
    expect(result.config.nativeTools).toEqual({
      nativeSubagents: true,
      nativeScheduling: false,
      nativeConnectors: false,
    });
    expect(result.report.version).toBe(7n);
    expect(result.report.issues).toEqual([]);
    expect(result.report.providers?.map((p) => [p.provider, p.available, p.version])).toEqual([
      [Provider.CLAUDE, true, "2.3.1"],
      [Provider.CODEX, true, "0.164.0"],
      [Provider.GROK, false, ""],
    ]);
    expect(JSON.stringify(result.report, (_, v) => (Predicate.isBigInt(v) ? String(v) : v))).not.toContain("sk-secret");
  });

  test("legacy allowedRoots are ignored even when relative, missing or symlinked", () => {
    const result = applyWorkerConfig(
      config({ allowedRoots: ["relative/path", join(base, "missing"), join(base, "link"), repo] }),
      probe,
    );

    if (!result.applied) throw new Error("expected applied");
    expect(result.report.issues).toEqual([]);
  });

  test("a missing CLI or a version mismatch disables that provider only", () => {
    const result = applyWorkerConfig(
      config({ codex: { enabled: true, requiredVersion: "0.170.0" }, claude: { enabled: true, executablePath: "" } }),
      { ...probe, which: (c) => (c === "codex" ? "/usr/bin/codex" : null) },
    );

    if (!result.applied) throw new Error("expected applied");
    expect(result.config.claude).toEqual({
      enabled: false,
      linkDeviceLogin: true,
      problem: "Claude Code is not installed on this computer",
    });
    expect(result.config.codex.enabled).toBe(false);
    expect(result.config.codex.problem).toBe("codex 0.164.0 found, 0.170.0 required");
  });

  test("Codex device login: linked by default, off for CLIProxyAPI-only workers", () => {
    const linked = applyWorkerConfig(config(), probe);
    const off = applyWorkerConfig(config({ codex: { enabled: true, deviceLogin: DeviceLogin.NONE } }), probe);
    expect(linked.applied && linked.config.codex.linkDeviceLogin).toBe(true);
    expect(off.applied && off.config.codex.linkDeviceLogin).toBe(false);
  });

  test("a configured Claude instance works without a default CLI while other instances report it missing", () => {
    const result = applyWorkerConfig(
      config({
        profiles: [
          {
            id: "custom",
            kind: ProviderProfileKind.CLIPROXYAPI,
            providers: [Provider.CLAUDE],
            baseUrl: "http://127.0.0.1:8317",
            apiKey: "test",
            executablePath: "/opt/custom/claude",
          },
        ],
      }),
      {
        ...probe,
        which: () => null,
        version: (path) => (path === "/opt/custom/claude" ? "2.3.1 (Claude Code)" : undefined),
      },
    );

    if (!result.applied) throw new Error("expected applied");
    expect(result.config.claude.enabled).toBe(true);
    expect(result.config.claude.executable).toBeUndefined();
    expect(
      result.config.profiles.find((status) => status.config.id === "custom")?.resolved?.runtime?.executablePath,
    ).toBe("/opt/custom/claude");
    expect(
      result.config.profiles.find(
        (status) => status.config.id === "native" && status.config.providers?.includes("claude"),
      )?.problem,
    ).toBe("Claude Code is not installed on this computer");
  });

  test("invalid profiles are fatal: the worker keeps its previous configuration", () => {
    const duplicate = { id: "p", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:8317", apiKey: "k" };
    const result = applyWorkerConfig(config({ profiles: [duplicate, duplicate] }), probe);
    expect(result.applied).toBe(false);
    expect(result.report.applied).toBe(false);
    expect(result.report.issues?.find((i) => i.fatal)?.message).toContain("duplicate profile id");
  });

  test("a profile without a key is reported unavailable, not fatal", () => {
    const result = applyWorkerConfig(
      config({ profiles: [{ id: "p", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:8317" }] }),
      probe,
    );

    expect(result.applied).toBe(true);
    expect(result.report.profiles?.find((p) => p.id === "p")).toMatchObject({
      available: false,
      detail: "api_key is not set",
    });
  });

  test("a profile for both harnesses is an instance per harness: Claude turned off leaves its Codex side usable", () => {
    const result = applyWorkerConfig(
      config({
        claude: { enabled: false },
        codex: { enabled: true, deviceLogin: DeviceLogin.NONE },
        profiles: [
          { id: "proxy", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:8317", apiKey: "k" },
        ],
      }),
      probe,
    );

    if (!result.applied) throw new Error("expected applied");
    expect(
      result.report.profiles?.filter((p) => p.id === "proxy").map((p) => [p.providers, p.available, p.detail]),
    ).toEqual([
      [[Provider.CLAUDE], false, "disabled in configuration"],
      [[Provider.CODEX], true, ""],
    ]);

    const codex = result.config.profiles.find(
      (s) => s.config.id === "proxy" && s.resolved?.providers.includes("codex"),
    );

    expect(codex?.resolved?.providers).toEqual(["codex"]);
  });
});

describe("applyWorkerConfig: custom profiles", () => {
  test("Antigravity uses agy or an instance executable and requires an explicit key with device login off", () => {
    const root = profileDir("canopy-agy-availability-");

    const homes = {
      dataDir: join(root, "data"),
      claude: join(root, "claude"),
      codex: join(root, "codex"),
      antigravity: join(root, "device"),
      env: {},
    };

    const custom = join(root, "selected-agy");
    const native = { providers: [Provider.ANTIGRAVITY], kind: ProviderProfileKind.NATIVE };

    const cli = {
      ...probe,
      which: () => null,
      version: (path: string) => (path === custom ? "agy version 1.5.16" : undefined),
      login: () => null,
    };

    const wire = config({
      antigravity: { enabled: true, requiredVersion: "1.5.16" },
      profiles: [
        { ...native, id: "own-executable", executablePath: custom, shadowHomePath: join(root, "private") },
        {
          ...native,
          id: "api",
          executablePath: custom,
          env: [{ name: "GEMINI_API_KEY", value: "fixture-key", secret: true }],
        },
      ],
    });

    const result = applyWorkerConfig(wire, cli, homes);

    if (!result.applied) throw new Error("expected applied");
    expect(result.config.antigravity.enabled).toBe(true);
    expect(result.report.profiles?.find((p) => p.id === "own-executable")).toMatchObject({
      providers: [Provider.ANTIGRAVITY],
      available: true,
      version: "1.5.16",
      loginHomePath: homes.antigravity,
      privateHomePath: join(root, "private"),
      authenticated: false,
      sandboxSupport: { offline: false, domains: false },
    });
    expect(
      result.report.profiles?.find((p) => p.id === "native" && p.providers?.includes(Provider.ANTIGRAVITY)),
    ).toMatchObject({
      available: false,
      detail: "agy CLI not found",
    });

    wire.antigravity!.deviceLogin = DeviceLogin.NONE;
    const off = applyWorkerConfig(wire, cli, homes).report;
    expect(off.profiles?.find((p) => p.id === "own-executable")).toMatchObject({ available: false });
    expect(off.profiles?.find((p) => p.id === "api")).toMatchObject({
      available: true,
      loginHomePath: "",
      auth: "Gemini API key configured",
      authenticated: false,
    });
    expect(JSON.stringify(off, (_, v) => (Predicate.isBigInt(v) ? String(v) : v))).not.toContain("fixture-key");
  });

  test("Antigravity blocks incompatible CLI versions and cannot send a device key to an instance endpoint", () => {
    const wire = config({
      antigravity: { enabled: true },
      profiles: [
        {
          id: "redirect",
          providers: [Provider.ANTIGRAVITY],
          kind: ProviderProfileKind.NATIVE,
          env: [{ name: "GOOGLE_GEMINI_BASE_URL", value: "http://127.0.0.1:8317" }],
        },
      ],
    });

    const root = profileDir("canopy-agy-version-");

    const homes = {
      dataDir: root,
      claude: join(root, "device-claude"),
      codex: join(root, "device-codex"),
      antigravity: join(root, "device-agy"),
      env: { GEMINI_API_KEY: "fixture-device-key" },
    };

    for (const version of ["1.5.15", "2.0.0", "1.5.16"]) {
      const result = applyWorkerConfig(
        wire,
        { ...probe, which: (name) => (name === "agy" ? "/bin/agy" : null), version: () => version },
        homes,
      );

      const native = result.report.profiles?.find(
        (p) => p.id === "native" && p.providers?.includes(Provider.ANTIGRAVITY),
      );

      expect(native?.available, version).toBe(version === "1.5.16");
      const redirect = result.report.profiles?.find((p) => p.id === "redirect");
      expect(redirect?.available).toBe(false);

      if (version === "1.5.16") expect(redirect?.detail).toContain("same Antigravity instance");
    }
  });

  test("Antigravity fails closed on unsupported settings and device home aliases, preserving legacy wildcard profiles", () => {
    const root = profileDir("canopy-agy-profile-");
    const device = join(root, "device");
    const alias = join(root, "alias");
    const shadow = join(root, "shadow");
    mkdirSync(device);
    mkdirSync(shadow);
    symlinkSync(device, alias, "dir");
    symlinkSync(device, join(shadow, "skills"), "dir");
    const native = { providers: [Provider.ANTIGRAVITY], kind: ProviderProfileKind.NATIVE };
    const proxy = { kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:8317", apiKey: "fixture" };

    const wire = config({
      antigravity: { enabled: true },
      profiles: [
        { ...proxy, id: "legacy" },
        { ...proxy, id: "mixed", providers: [Provider.CLAUDE, Provider.ANTIGRAVITY] },
        {
          ...native,
          id: "mixed-shared",
          providers: [Provider.CODEX, Provider.ANTIGRAVITY],
          userConfiguration: { mode: ProviderConfigurationMode.SHARED },
        },
        { ...native, id: "login", ownLogin: true },
        { ...native, id: "source", homePath: device },
        { ...native, id: "args", launchArgs: ["--login"] },
        { ...native, id: "settings", settingsText: "{}" },
        { ...native, id: "shared", userConfiguration: { mode: ProviderConfigurationMode.SHARED } },
        { ...native, id: "user-skills", userConfiguration: { skills: true } },
        { ...native, id: "nested", shadowHomePath: join(alias, "private") },
        { ...native, id: "ancestor", shadowHomePath: root },
        { ...native, id: "skill-alias", shadowHomePath: shadow },
      ],
    });

    const result = applyWorkerConfig(
      wire,
      { ...probe, which: (command) => `/bin/${command}`, version: () => "1.5.16" },
      {
        dataDir: join(root, "data"),
        claude: join(root, "claude"),
        codex: join(root, "codex"),
        antigravity: device,
        env: {},
      },
    );

    const profiles = result.report.profiles ?? [];
    expect(result.applied).toBe(true);
    expect(profiles.filter((p) => p.id === "legacy").map((p) => p.providers)).toEqual([
      [Provider.CLAUDE],
      [Provider.CODEX],
    ]);
    expect(profiles.find((p) => p.id === "mixed" && p.providers?.includes(Provider.CLAUDE))?.available).toBe(true);
    expect(profiles.find((p) => p.id === "mixed-shared" && p.providers?.includes(Provider.CODEX))?.available).toBe(
      false,
    );
    expect(profiles.filter((p) => p.providers?.includes(Provider.ANTIGRAVITY) && p.available).map((p) => p.id)).toEqual(
      ["native"],
    );
  });

  test("Grok availability uses the same custom auth path as login and respects isolated homes", () => {
    const device = tempDir("canopy-grok-availability-");
    const custom = join(device, "custom-login.json");
    writeFileSync(custom, "fixture-login");

    const result = applyWorkerConfig(
      config({
        grok: { enabled: true },
        profiles: [
          { id: "native", providers: [Provider.GROK], kind: ProviderProfileKind.NATIVE },
          { id: "own", providers: [Provider.GROK], kind: ProviderProfileKind.NATIVE, ownLogin: true },
          {
            id: "custom-home",
            providers: [Provider.GROK],
            kind: ProviderProfileKind.NATIVE,
            homePath: device,
          },
        ],
      }),
      { ...probe, which: () => "grok", login: systemProbe.login! },
      { dataDir: device, claude: device, codex: device, grok: device, env: { GROK_AUTH_PATH: custom } },
    );

    if (!result.applied) throw new Error("expected applied");
    const native = result.config.profiles.find((p) => p.config.id === "native" && p.config.providers?.includes("grok"));
    expect(native?.authenticated).toBe(true);
    expect(native?.resolved).toBeDefined();

    for (const id of ["own", "custom-home"]) {
      const isolated = result.config.profiles.find((p) => p.config.id === id);
      expect(isolated?.authenticated).toBe(false);
      expect(isolated?.resolved).toBeUndefined();
    }
  });

  test("carries names, variables and the disabled flag; a bad variable is an issue of that profile only", () => {
    const result = applyWorkerConfig(
      config({
        profiles: [
          {
            id: "team",
            kind: ProviderProfileKind.CLIPROXYAPI,
            baseUrl: "http://127.0.0.1:8317",
            apiKey: "k",
            displayName: "Team",
            env: [
              { name: "PROBE", value: "1" },
              { name: "TOKEN", value: "hidden-value", secret: true },
            ],
          },
          { id: "off", kind: ProviderProfileKind.NATIVE, disabled: true },
          { id: "bad", kind: ProviderProfileKind.NATIVE, env: [{ name: "PATH", value: "/evil-path" }] },
        ],
      }),
      probe,
    );

    if (!result.applied) throw new Error("expected applied");
    const byId = new Map(result.config.profiles.map((p) => [p.config.id, p]));
    expect(byId.get("team")?.resolved?.env).toEqual({ PROBE: "1", TOKEN: "hidden-value" });
    expect(byId.get("off")?.problem).toBe("disabled");
    expect(byId.get("bad")?.resolved).toBeUndefined();
    expect(result.report.issues?.map((i) => i.path)).toEqual(["profiles[bad]"]);
    expect(result.report.profiles?.find((p) => p.id === "team")?.displayName).toBe("Team");
    expect(JSON.stringify(result.report, (_k, v) => (Predicate.isBigInt(v) ? String(v) : v))).not.toContain(
      "hidden-value",
    );
    expect(JSON.stringify(result.report, (_k, v) => (Predicate.isBigInt(v) ? String(v) : v))).not.toContain(
      "/evil-path",
    );
  });
});
