import { describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "@canopy/testing";
import { prepareClaudeHome } from "./home.ts";

const base = tempDir("canopy-claude-home-test-");

describe("prepareClaudeHome", () => {
  test("does not remove credentials when the configured homes are the same", () => {
    const deviceHome = mkdtempSync(join(base, "device-"));
    const credentials = join(deviceHome, ".credentials.json");
    writeFileSync(credentials, "fixture-credentials");

    expect(() =>
      prepareClaudeHome({
        dataDir: deviceHome,
        path: deviceHome,
        linkDeviceLogin: true,
        deviceClaudeHome: deviceHome,
      }),
    ).toThrow("shadow home is also the device CLI home");
    expect(readFileSync(credentials, "utf8")).toBe("fixture-credentials");
  });

  test("protects the actual device home through an ancestor alias when the login source is customized", () => {
    const root = mkdtempSync(join(base, "actual-"));
    const deviceHome = join(root, ".claude");
    mkdirSync(deviceHome);
    const credentials = join(deviceHome, ".credentials.json");
    writeFileSync(credentials, "fixture-device-login");
    const source = mkdtempSync(join(base, "custom-source-"));
    writeFileSync(join(source, ".credentials.json"), "fixture-custom-login");
    const alias = join(base, `alias-${Bun.randomUUIDv7()}`);
    symlinkSync(root, alias, "junction");

    expect(() =>
      prepareClaudeHome({
        dataDir: root,
        path: join(alias, ".claude"),
        deviceClaudeHome: source,
        protectedDeviceHome: deviceHome,
        ownLogin: true,
        linkDeviceLogin: false,
      }),
    ).toThrow("shadow home is also the device CLI home");
    expect(readFileSync(credentials, "utf8")).toBe("fixture-device-login");
    expect(readFileSync(join(source, ".credentials.json"), "utf8")).toBe("fixture-custom-login");
  });

  test("a canonical lookup failure stops preparation before credentials or directories change", () => {
    const root = mkdtempSync(join(base, "canonical-error-"));
    const source = mkdtempSync(join(base, "source-"));
    writeFileSync(join(source, ".credentials.json"), "fixture-device-login");
    const loop = join(root, "loop");
    symlinkSync(loop, loop);

    expect(() =>
      prepareClaudeHome({
        dataDir: root,
        path: join(loop, "shadow"),
        deviceClaudeHome: source,
        linkDeviceLogin: false,
      }),
    ).toThrow("Cannot inspect the provider home");
    expect(lstatSync(loop).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(source, ".credentials.json"), "utf8")).toBe("fixture-device-login");
  });
});
