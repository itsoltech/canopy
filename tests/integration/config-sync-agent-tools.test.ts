/** Nested optional session defaults must sync both values and removal back to tool defaults. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { configComputer, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("agent-tool defaults across linked computers", () => {
  let a: ConfigComputer;
  let b: ConfigComputer;

  beforeAll(async () => {
    a = await configComputer("Defaults A");
    b = await configComputer("Defaults B");
    await pairConfig(a, b);
  }, 90_000);
  afterAll(async () => {
    await Promise.allSettled([a?.close(), b?.close()]);
  }, 30_000);

  test("propagates nested values, explicit false and resets to absent optional fields", async () => {
    await a.update({
      agentToolDefaults: {
        browser: { viewportWidth: 1280, viewportHeight: 800, colorScheme: "dark" },
        desktop: { app: "Canopy", allowPhysicalInput: true },
        device: { platform: "apple", allowBoot: false, acquireTimeoutSeconds: 30 },
      },
    });

    const saved = await eventually(
      async () => (await b.settings()).agentToolDefaults,
      (value) =>
        value?.browser?.viewportWidth === 1280 &&
        value?.device?.allowBoot === false &&
        value?.desktop?.allowPhysicalInput === true,
      20_000,
    );

    expect(saved?.browser).toMatchObject({ viewportWidth: 1280, viewportHeight: 800, colorScheme: "dark" });
    expect(saved?.device).toMatchObject({ platform: "apple", allowBoot: false, acquireTimeoutSeconds: 30 });
    expect(saved?.desktop).toMatchObject({ app: "Canopy", allowPhysicalInput: true });
    await a.update({ agentToolDefaults: {} });

    const reset = await eventually(
      async () => (await b.settings()).agentToolDefaults,
      (value) =>
        value?.browser?.viewportWidth === undefined &&
        value?.device?.allowBoot === undefined &&
        value?.desktop?.app === "" &&
        value?.desktop?.allowPhysicalInput === false,
      20_000,
    );

    expect(reset?.browser).toMatchObject({ colorScheme: "" });
    expect(reset?.browser?.viewportHeight).toBeUndefined();
    expect(reset?.device?.platform).toBe("");
    expect(reset?.device?.acquireTimeoutSeconds).toBeUndefined();
    await b.restart();
    const restarted = (await b.settings()).agentToolDefaults;
    expect(restarted?.device?.allowBoot).toBeUndefined();
    expect(restarted?.browser?.viewportWidth).toBeUndefined();
    expect(restarted?.desktop?.allowPhysicalInput).toBe(false);
  }, 60_000);
});
