import { expect, test } from "bun:test";
import { tempDirs } from "@canopy/testing";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexAppServerLaunch } from "./codex/launch.ts";
import { grokLaunch } from "./grok/launch.ts";

const temp = tempDirs();

for (const provider of ["codex", "grok"] as const) {
  test(`${provider} thread shells inherit the device home, XDG paths and git identity`, () => {
    const home = temp("canopy-thread-shell-home-");
    const dataDir = temp("canopy-thread-shell-data-");

    const env = {
      PATH: process.env["PATH"],
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_CACHE_HOME: join(home, "cache"),
    };

    mkdirSync(env.XDG_CONFIG_HOME);
    writeFileSync(join(home, ".gitconfig"), "[user]\nname = Fixture Developer\nemail = fixture@example.invalid\n");

    const profile = { kind: "native", id: "fixture", providers: [provider], env: {}, runtime: {} } as const;

    const grok =
      provider === "grok" ? grokLaunch({ dataDir, profile, baseEnv: env, linkDeviceLogin: false }) : undefined;

    const launchEnv = grok?.options.env ?? codexAppServerLaunch([profile], env, "codex", undefined, dataDir).env;

    try {
      for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const)
        expect(launchEnv[key]).toBe(env[key]);

      const git = Bun.spawnSync(["git", "config", "--global", "user.email"], { env: launchEnv, cwd: dataDir });
      expect(git.exitCode).toBe(0);
      expect(git.stdout.toString().trim()).toBe("fixture@example.invalid");
    } finally {
      grok?.cleanup();
    }
  });
}
