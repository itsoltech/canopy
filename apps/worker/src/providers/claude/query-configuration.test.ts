import { expect, test } from "bun:test";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { PermissionMode, ProviderConfigurationMode } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeJsonObject } from "../json.ts";
import { claudePermissions } from "./permissions.ts";
import { claudeQueryConfiguration } from "./query-configuration.ts";

const temp = tempDirs();
const hooks = { PreToolUse: [{ hooks: [{ type: "command", command: "synthetic-hook-never-executed" }] }] };

const modes = [
  PermissionMode.ASK,
  PermissionMode.ACCEPT_EDITS,
  PermissionMode.READ_ONLY,
  PermissionMode.FULL_ACCESS,
  PermissionMode.FULL_AUTO,
];

for (const platform of ["win32", "linux"] as const) {
  for (const importHooks of [false, true]) {
    for (const mode of modes) {
      test(`Claude SDK settings at spawn: ${platform}, ${PermissionMode[mode]}, hooks=${importHooks}`, async () => {
        const home = temp("canopy-claude-query-");
        const source = temp("canopy-claude-query-source-");
        const sourceSettings = join(source, "settings.json");
        const original = JSON.stringify({ hooks, sandbox: { enabled: true, allowUnsandboxedCommands: true } });
        writeFileSync(sourceSettings, original);

        const { options: permissions } = claudePermissions(mode, platform);

        const config = await claudeQueryConfiguration(
          {
            home,
            sourceHome: source,
            userConfiguration: {
              mode: ProviderConfigurationMode.LOCAL,
              sourcePath: "",
              hooks: importHooks,
              skills: false,
              instructions: false,
            },
          },
          home,
          true,
          {},
          permissions,
        );

        let args: readonly string[] = [];
        const stop = new Error("Synthetic spawn boundary");

        try {
          await expect(
            (async () => {
              const q = query({
                prompt: "",
                options: {
                  ...config.options,
                  spawnClaudeCodeProcess: (spawn) => {
                    args = spawn.args;
                    throw stop;
                  },
                },
              });

              try {
                await q.supportedCommands();
              } finally {
                q.close();
              }
            })(),
          ).rejects.toThrow(stop.message);
          expect(args).toContain("--settings");
          const argument = args[args.indexOf("--settings") + 1] ?? "";
          const settings = decodeJsonObject(JSON.parse(importHooks ? readFileSync(argument, "utf8") : argument));

          expect(settings["hooks"]).toEqual(importHooks ? hooks : undefined);
          expect(settings["sandbox"]).toEqual(permissions.sandbox);
          expect(settings["disableSkillShellExecution"]).toBe(true);
          expect(config.options.permissionMode).toBe(permissions.permissionMode);
          expect(readFileSync(sourceSettings, "utf8")).toBe(original);
        } finally {
          await config.close();
        }

        if (importHooks) expect(existsSync(args[args.indexOf("--settings") + 1] ?? "")).toBe(false);
      });
    }
  }
}
