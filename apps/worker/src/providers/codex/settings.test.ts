import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ProviderProfileKind, WorkerConfigSchema } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { Effect } from "effect";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyWorkerConfig } from "../../config/remote.ts";
import { selectProfile } from "../profiles.ts";
import { CodexAppServer } from "./app-server.ts";
import { codexAppServerLaunch } from "./launch.ts";

const temp = tempDirs();
const executable = Bun.which("codex");

test.skipIf(!executable)(
  "Codex applies merged preferences before explicit launch flags",
  async () => {
    const home = realpathSync(temp("canopy-codex-settings-"));
    const configPath = join(home, "config.toml");
    const original = 'model_verbosity = "high"\n';
    writeFileSync(configPath, original);

    const apply = (settingsText: string, settingsOverrideText: string) => {
      const applied = applyWorkerConfig(
        create(WorkerConfigSchema, {
          codex: { enabled: true, executablePath: executable! },
          profiles: [
            {
              id: "native",
              providers: [Provider.CODEX],
              kind: ProviderProfileKind.NATIVE,
              settingsText,
              settingsOverrideText,
              launchArgs: ["-c", 'model_reasoning_effort="medium"'],
            },
            {
              id: "invalid",
              providers: [Provider.CODEX],
              kind: ProviderProfileKind.NATIVE,
              settingsOverrideText: 'api_key = "fixture-value"',
            },
          ],
        }),
        { which: () => null, realDirectory: (path) => path, version: () => undefined },
      );

      if (!applied.applied) throw new Error("Expected worker config to apply.");
      const invalid = applied.report.profiles?.find((profile) => profile.id === "invalid");
      expect(invalid?.available).toBe(false);
      expect(invalid?.detail).toContain("config.toml");
      expect(invalid?.detail).not.toContain("fixture-value");

      return selectProfile(applied.config.profiles, "native", "codex");
    };

    const profile = apply(
      'model_context_window = 64000\nmodel_verbosity = "high"\nmodel_reasoning_effort = "low"',
      'model_verbosity = "low"',
    );

    const equivalent = apply(
      '# Only effective values enter the runtime snapshot.\nmodel_verbosity = "medium"',
      'model_reasoning_effort = "low"\nmodel_verbosity = "low"\nmodel_context_window = 64000',
    );

    expect(JSON.stringify(equivalent.runtime)).toBe(JSON.stringify(profile.runtime));

    const launch = codexAppServerLaunch(
      [profile],
      { ...process.env, HOME: home, USERPROFILE: home },
      executable!,
      undefined,
      home,
      undefined,
      profile.runtime.launchArgs,
    );

    const { config } = await Effect.runPromise(
      CodexAppServer.use((server) => server.request("config/read", {})).pipe(
        Effect.provide(
          CodexAppServer.layer({
            launch,
            clientVersion: "test",
            onServerRequest: async () => null,
          }),
        ),
        Effect.timeout("10 seconds"),
      ),
    );

    expect(config).toMatchObject({
      model_context_window: 64_000,
      model_reasoning_effort: "medium",
      model_verbosity: "low",
    });
    expect(readFileSync(configPath, "utf8")).toBe(original);
  },
  15_000,
);
