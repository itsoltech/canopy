import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { Provider, ProviderProfileKind, WorkerConfigSchema } from "@open-agents/contracts";
import { applyWorkerConfig, isAllowedPath, systemProbe, type DeviceProbe } from "./remote.ts";

const base = mkdtempSync(join(tmpdir(), "oa-remote-config-"));
const repo = join(base, "repo");
mkdirSync(join(repo, "sub"), { recursive: true });
symlinkSync(repo, join(base, "link"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

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
    expect(result.config.allowedRoots).toEqual([repo]);
    expect(result.config.claude).toEqual({ enabled: true, executable: "/usr/bin/claude", version: "2.3.1" });
    expect(result.config.limits.maxRunningTurns).toBe(2);
    expect(result.config.limits.drainTimeoutSeconds).toBe(600); // default when unset
    expect(result.config.nativeTools).toEqual({ nativeSubagents: true, nativeScheduling: false });
    expect(result.report.version).toBe(7n);
    expect(result.report.issues).toEqual([]);
    expect(result.report.providers?.map((p) => [p.provider, p.available, p.version])).toEqual([
      [Provider.CLAUDE, true, "2.3.1"],
      [Provider.CODEX, true, "0.164.0"],
    ]);
    expect(JSON.stringify(result.report, (_, v) => (typeof v === "bigint" ? String(v) : v))).not.toContain("sk-secret");
  });

  test("bad roots are skipped with an issue; symlinks resolve to real paths", () => {
    const result = applyWorkerConfig(config({ allowedRoots: ["relative/path", join(base, "missing"), join(base, "link"), repo] }), probe);
    if (!result.applied) throw new Error("expected applied");
    expect(result.config.allowedRoots).toEqual([repo]);
    expect(result.report.issues?.map((i) => i.path)).toEqual(["allowed_roots[0]", "allowed_roots[1]"]);
  });

  test("a missing CLI or a version mismatch disables that provider only", () => {
    const result = applyWorkerConfig(
      config({ codex: { enabled: true, requiredVersion: "0.170.0" }, claude: { enabled: true, executablePath: "" } }),
      { ...probe, which: (c) => (c === "codex" ? "/usr/bin/codex" : null) },
    );
    if (!result.applied) throw new Error("expected applied");
    expect(result.config.claude).toEqual({ enabled: false, problem: "claude CLI not found" });
    expect(result.config.codex.enabled).toBe(false);
    expect(result.config.codex.problem).toBe("codex 0.164.0 found, 0.170.0 required");
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

  test("isAllowedPath: inside a root, not a sibling with the same prefix", () => {
    const applied = { allowedRoots: [repo] };
    expect(isAllowedPath(applied, repo)).toBe(true);
    expect(isAllowedPath(applied, join(repo, "sub"))).toBe(true);
    expect(isAllowedPath(applied, `${repo}-other`)).toBe(false);
    expect(isAllowedPath(applied, base)).toBe(false);
  });
});
