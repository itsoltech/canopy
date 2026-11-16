import { describe, expect, test } from "bun:test";
import { create, fromJson, type MessageInitShape } from "@bufbuild/protobuf";
import { Provider, ProviderConfigurationMode, ProviderProfileKind, WorkerConfigSchema } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { applyWorkerConfig, type DeviceProbe } from "./remote.ts";

const probe: DeviceProbe = {
  which: (command) => `/fixture/${command}`,
  version: () => "1.0.0",
  realDirectory: (path) => path,
  login: () => "fixture login",
};

function fixture(profiles: NonNullable<MessageInitShape<typeof WorkerConfigSchema>["profiles"]>) {
  const root = tempDir("canopy-configuration-policy-");
  const homes = { dataDir: join(root, "data"), claude: join(root, "device-claude"), codex: join(root, "device-codex") };
  mkdirSync(homes.claude);
  mkdirSync(homes.codex);

  const config = create(WorkerConfigSchema, {
    version: 1n,
    claude: { enabled: true },
    codex: { enabled: true },
    grok: { enabled: true },
    profiles,
  });

  return { root, homes, config };
}

describe("WorkerConfig user configuration policy and effective paths", () => {
  test("protobuf policies survive decoding; the three modes report independent storage and login paths", () => {
    const sources = ["~", "~/.claude/configured", "~\\.claude\\configured"];

    const modes = [
      ProviderConfigurationMode.ISOLATED,
      ProviderConfigurationMode.LOCAL,
      ProviderConfigurationMode.SHARED,
    ];

    for (const [index, mode] of modes.entries()) {
      const policy = { mode, sourcePath: sources[index]!, instructions: true, skills: false, hooks: true };

      const { homes, config } = fixture([
        {
          id: "configured",
          providers: [Provider.CLAUDE],
          kind: ProviderProfileKind.NATIVE,
          userConfiguration: policy,
        },
      ]);

      const result = applyWorkerConfig(config, probe, homes);

      if (!result.applied) throw new Error("Expected configuration to apply.");
      const profile = result.config.profiles.find((status) => status.config.id === "configured");
      expect(profile?.resolved?.runtime.userConfiguration).toEqual(policy);
      const privateHome = join(homes.dataDir, "claude-home");
      const source = index === 0 ? homedir() : join(homedir(), ".claude", "configured");
      expect(result.report.profiles?.find((status) => status.id === "configured")).toMatchObject({
        available: true,
        loginHomePath: homes.claude,
        privateHomePath: privateHome,
        configurationHomePath: mode === ProviderConfigurationMode.ISOLATED ? privateHome : source,
        sessionHomePath: mode === ProviderConfigurationMode.SHARED ? source : privateHome,
      });
    }
  });

  test("legacy defaults remain isolated and an own login stays private in shared mode", () => {
    const { homes, config } = fixture([
      { id: "legacy", providers: [Provider.CLAUDE], kind: ProviderProfileKind.NATIVE },
      {
        id: "own",
        providers: [Provider.CLAUDE],
        kind: ProviderProfileKind.NATIVE,
        ownLogin: true,
        userConfiguration: { mode: ProviderConfigurationMode.SHARED, sourcePath: "~/configuration" },
      },
    ]);

    const result = applyWorkerConfig(config, probe, homes);
    expect(result.applied).toBe(true);
    expect(result.report.profiles?.find((status) => status.id === "legacy")).toMatchObject({
      sessionHomePath: join(homes.dataDir, "claude-home"),
      configurationHomePath: join(homes.dataDir, "claude-home"),
    });
    expect(result.report.profiles?.find((status) => status.id === "own")).toMatchObject({
      loginHomePath: join(homes.dataDir, "homes", "claude-own"),
      privateHomePath: join(homes.dataDir, "homes", "claude-own"),
      sessionHomePath: join(homedir(), "configuration"),
    });
  });

  test("invalid policies disable only their profile, including a non-Claude side of a legacy mixed profile", () => {
    const { homes, config } = fixture([
      { id: "mixed", kind: ProviderProfileKind.NATIVE, userConfiguration: { mode: ProviderConfigurationMode.SHARED } },
      {
        id: "relative",
        providers: [Provider.CLAUDE],
        kind: ProviderProfileKind.NATIVE,
        userConfiguration: { mode: ProviderConfigurationMode.LOCAL, sourcePath: "relative/config" },
      },
    ]);

    config.profiles.push(
      ...fromJson(WorkerConfigSchema, {
        profiles: [
          {
            id: "invalid-mode",
            kind: "PROVIDER_PROFILE_KIND_NATIVE",
            providers: ["PROVIDER_CLAUDE"],
            userConfiguration: { mode: 99 },
          },
        ],
      }).profiles,
    );
    const result = applyWorkerConfig(config, probe, homes);
    expect(result.applied).toBe(true);
    const reports = result.report.profiles ?? [];
    expect(reports.find((p) => p.id === "mixed" && p.providers?.includes(Provider.CLAUDE))?.available).toBe(true);
    expect(reports.find((p) => p.id === "mixed" && p.providers?.includes(Provider.CODEX))).toMatchObject({
      available: false,
    });
    expect(reports.find((p) => p.id === "relative")).toMatchObject({ available: false });
    expect(reports.find((p) => p.id === "invalid-mode")).toMatchObject({ available: false });
    expect(reports.find((p) => p.id === "native" && p.providers?.includes(Provider.CODEX))?.available).toBe(true);
  });

  test("filesystem failures and a source that is a file do not reject other profiles or mutate the source", () => {
    const { root, homes, config } = fixture([]);
    const loop = join(root, "loop");
    symlinkSync(loop, loop);
    const file = join(root, "source-file");
    writeFileSync(file, "fixture-source");
    config.profiles.push(
      ...create(WorkerConfigSchema, {
        profiles: [
          { id: "bad-home", providers: [Provider.CLAUDE], kind: ProviderProfileKind.NATIVE, shadowHomePath: loop },
          {
            id: "bad-source",
            providers: [Provider.CLAUDE],
            kind: ProviderProfileKind.NATIVE,
            userConfiguration: { mode: ProviderConfigurationMode.SHARED, sourcePath: file },
          },
        ],
      }).profiles,
    );
    const result = applyWorkerConfig(config, probe, homes);
    expect(result.applied).toBe(true);
    expect(result.report.profiles?.find((p) => p.id === "bad-home")).toMatchObject({ available: false });
    expect(result.report.profiles?.find((p) => p.id === "bad-source")).toMatchObject({ available: false });
    expect(
      result.report.profiles?.find((p) => p.id === "native" && p.providers?.includes(Provider.CLAUDE))?.available,
    ).toBe(true);
  });
});
