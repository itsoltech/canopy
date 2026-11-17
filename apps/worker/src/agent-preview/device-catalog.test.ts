import { expect, test } from "bun:test";
import { AgentTool } from "@canopy/contracts";
import { deviceCatalog } from "./catalog.ts";
import { PreviewRuntime } from "./runtime.ts";
import { previewFixture } from "./fixtures.test-support.ts";

test("Device Preview lists only its active session device and rejects a foreign pinned target", async () => {
  const f = await previewFixture(AgentTool.DEVICE);

  const devices = [
    { id: "mine", name: "Mine", platform: "android", claimedBy: { session: "thread", workspace: "/workspace" } },
    { id: "other", name: "Other thread", platform: "android" },
    { id: "free", name: "Free", platform: "android" },
  ];

  f.update({
    devices,
    sessions: [
      { name: "thread", id: "mine", platform: "android" },
      { name: "another-thread", id: "other", platform: "android" },
    ],
  });
  const catalog = await deviceCatalog(f.runtime());
  expect(catalog.targetId).toBe("android:mine");
  expect(catalog.targets.map((target) => target.deviceId)).toEqual(["mine"]);
  const pinned = f.runtime();
  pinned.scope.deviceId = "other";
  expect((await deviceCatalog(pinned)).targetId).toBe("");
  expect(f.calls().every((call) => ["session", "devices"].includes(call.command))).toBe(true);
});

test("unreserved Device Preview hides foreign claims, active sessions, stopped emulators and other platforms", async () => {
  const f = await previewFixture(AgentTool.DEVICE);
  f.update({
    sessions: [{ name: "another-thread", id: "other", platform: "android" }],
    devices: [
      {
        id: "claimed",
        name: "Claimed elsewhere",
        platform: "android",
        claimedBy: { session: "outside", workspace: "/other" },
      },
      { id: "other", name: "Other thread", platform: "android" },
      { id: "stopped", name: "Stopped", platform: "android", kind: "emulator", booted: false },
      { id: "unknown", name: "Unknown simulator state", platform: "ios", kind: "simulator" },
      { id: "free", name: "Free", platform: "android", kind: "emulator", booted: true },
      { id: "ios", name: "iPhone", platform: "ios", kind: "simulator", booted: true },
    ],
  });
  const runtime = f.runtime();
  runtime.scope.platform = "android";
  const catalog = await deviceCatalog(runtime);
  expect(catalog.targetId).toBe("android:free");
  expect(catalog.targets.map((target) => target.deviceId)).toEqual(["free"]);
  const foreign = f.runtime();
  foreign.scope.deviceId = "claimed";
  expect((await deviceCatalog(foreign)).selected).toBe(false);
});

test("Preview uses live worker reservations before a device appears in the daemon session list", async () => {
  const f = await previewFixture(AgentTool.DEVICE);

  const devices = [
    { id: "emulator-5554", name: "Mine", platform: "android", kind: "emulator", booted: true },
    { id: "emulator-5556", name: "Other", platform: "android", kind: "emulator", booted: true },
  ] as const;

  f.update({ devices: [...devices], sessions: [] });

  try {
    await f.tools.report();
    const managed = f.tools.localMcpServers([AgentTool.DEVICE], "thread")[0]?.managed;
    expect(managed).toBeDefined();
    const runtime = new PreviewRuntime(await f.tools.resolvePreviewScope(f.scope), new AbortController().signal);
    expect((await deviceCatalog(runtime)).targets).toHaveLength(2);

    const result = await managed?.call(
      { name: "acquire_device", arguments: { device: "emulator-5554", boot: false } },
      new AbortController().signal,
      async () => undefined,
    );

    expect(result?.isError).not.toBe(true);
    expect(result?.content).toHaveLength(1);
    const catalog = await deviceCatalog(runtime);
    expect(catalog.targetId).toBe("android:emulator-5554");
    expect(catalog.targets.map((target) => target.deviceId)).toEqual(["emulator-5554"]);
    const otherScope = { ...f.scope, session: "another-thread" };

    const otherRuntime = new PreviewRuntime(
      await f.tools.resolvePreviewScope(otherScope),
      new AbortController().signal,
    );

    expect((await deviceCatalog(otherRuntime)).targets.map((target) => target.deviceId)).toEqual(["emulator-5556"]);
  } finally {
    await f.tools.close();
  }
});
