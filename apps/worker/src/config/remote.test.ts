import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { DeviceLogin, Provider, ProviderProfileKind, WorkerConfigSchema } from "@open-agents/contracts";
import { tempDir } from "@open-agents/testing";
import { applyWorkerConfig, systemProbe, type DeviceProbe } from "./remote.ts";

const base = tempDir("oa-remote-config-");
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
        profiles: [{ id: "proxy", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:8317", apiKey: "sk-secret" }],
        limits: { maxRunningTurns: 2 },
        nativeTools: { subagents: true },
      }),
      probe,
    );
    if (!result.applied) throw new Error("expected applied");
    expect(result.config.claude).toEqual({ enabled: true, linkDeviceLogin: true, executable: "/usr/bin/claude", version: "2.3.1" });
    expect(result.config.limits.maxRunningTurns).toBe(2);
    expect(result.config.limits.drainTimeoutSeconds).toBe(600); // default when unset
    expect(result.config.nativeTools).toEqual({ nativeSubagents: true, nativeScheduling: false, nativeConnectors: false });
    expect(result.report.version).toBe(7n);
    expect(result.report.issues).toEqual([]);
    expect(result.report.providers?.map((p) => [p.provider, p.available, p.version])).toEqual([
      [Provider.CLAUDE, true, "2.3.1"],
      [Provider.CODEX, true, "0.164.0"],
      [Provider.GROK, false, ""],
    ]);
    expect(JSON.stringify(result.report, (_, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain("sk-secret");
  });

  test("legacy allowedRoots are ignored even when relative, missing or symlinked", () => {
    const result = applyWorkerConfig(config({ allowedRoots: ["relative/path", join(base, "missing"), join(base, "link"), repo] }), probe);
    if (!result.applied) throw new Error("expected applied");
    expect(result.report.issues).toEqual([]);
  });

  test("a missing CLI or a version mismatch disables that provider only", () => {
    const result = applyWorkerConfig(
      config({ codex: { enabled: true, requiredVersion: "0.170.0" }, claude: { enabled: true, executablePath: "" } }),
      { ...probe, which: (c) => (c === "codex" ? "/usr/bin/codex" : null) },
    );
    if (!result.applied) throw new Error("expected applied");
    expect(result.config.claude).toEqual({ enabled: false, linkDeviceLogin: true, problem: "claude CLI not found" });
    expect(result.config.codex.enabled).toBe(false);
    expect(result.config.codex.problem).toBe("codex 0.164.0 found, 0.170.0 required");
  });

  test("Codex device login: linked by default, off for CLIProxyAPI-only workers", () => {
    const linked = applyWorkerConfig(config(), probe);
    const off = applyWorkerConfig(config({ codex: { enabled: true, deviceLogin: DeviceLogin.NONE } }), probe);
    expect(linked.applied && linked.config.codex.linkDeviceLogin).toBe(true);
    expect(off.applied && off.config.codex.linkDeviceLogin).toBe(false);
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
    expect(result.report.profiles?.find((p) => p.id === "p")).toMatchObject({ available: false, detail: "api_key is not set" });
  });

  test("a profile for both harnesses is an instance per harness: Claude turned off leaves its Codex side usable", () => {
    const result = applyWorkerConfig(
      config({
        claude: { enabled: false },
        codex: { enabled: true, deviceLogin: DeviceLogin.NONE },
        profiles: [{ id: "proxy", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:8317", apiKey: "k" }],
      }),
      probe,
    );
    if (!result.applied) throw new Error("expected applied");
    expect(result.report.profiles?.filter((p) => p.id === "proxy").map((p) => [p.providers, p.available, p.detail])).toEqual([
      [[Provider.CLAUDE], false, "disabled in configuration"],
      [[Provider.CODEX], true, ""],
    ]);
    const codex = result.config.profiles.find((s) => s.config.id === "proxy" && s.resolved?.providers.includes("codex"));
    expect(codex?.resolved?.providers).toEqual(["codex"]);
  });

});

describe("applyWorkerConfig: custom profiles", () => {
  test("carries names, variables and the disabled flag; a bad variable is an issue of that profile only", () => {
    const result = applyWorkerConfig(
      config({
        profiles: [
          { id: "team", kind: ProviderProfileKind.CLIPROXYAPI, baseUrl: "http://127.0.0.1:8317", apiKey: "k", displayName: "Team", env: [{ name: "PROBE", value: "1" }, { name: "TOKEN", value: "hidden-value", secret: true }] },
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
    expect(JSON.stringify(result.report, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain("hidden-value");
    expect(JSON.stringify(result.report, (_k, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain("/evil-path");
  });
});
