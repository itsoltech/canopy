import { expect, test } from "bun:test";
import { GatewayUpdates } from "./runtime.ts";

test("a persisted latest setting is rewritten as stable and remains stable for legacy requests", async () => {
  let stored = "latest";

  const updates = new GatewayUpdates({
    kind: "source",
    version: "0.1.0",
    cacheDir: "/unused-update-cache",
    authenticate: async () => undefined,
    persistence: {
      admin: async () => true,
      channel: async () => stored,
      setChannel: async (value) => {
        stored = value;
      },
      workers: async () => [],
      hello: async () => {},
      saveCommand: async () => {},
      report: async () => {},
    },
    source: { fetch: async () => Response.json([]) },
  });

  try {
    await updates.start();
    expect(stored).toBe("stable");
    expect((await updates.snapshot()).channel).toBe("stable");
    // The gateway accepts old clients without retaining the obsolete setting.
    const { create } = await import("@bufbuild/protobuf");
    const { ui } = await import("@canopy/contracts");
    expect(
      (await updates.manage(create(ui.ManageUpdatesRequestSchema, { action: "channel", channel: "latest" }))).channel,
    ).toBe("stable");
    expect(stored).toBe("stable");
  } finally {
    updates.close();
  }
});

test("gateway and linked checks reuse API backoff and expose a scheduled check without failing the gateway", async () => {
  let apiCalls = 0;
  const reset = Math.ceil(Date.now() / 1000) + 3600;

  const updates = new GatewayUpdates({
    kind: "source",
    version: "0.1.0",
    cacheDir: "/unused-update-cache",
    authenticate: async () => undefined,
    persistence: {
      admin: async () => true,
      channel: async () => "stable",
      setChannel: async () => {},
      workers: async () => [],
      hello: async () => {},
      saveCommand: async () => {},
      report: async () => {},
    },
    source: {
      fetch: async (input) => {
        if (!String(input).includes("api.github.com")) return new Response(null, { status: 503 });
        apiCalls++;

        return new Response(null, {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) },
        });
      },
    },
  });

  try {
    await updates.start();
    await updates.check();
    await Promise.all(Array.from({ length: 10 }, () => updates.check()));
    const snapshot = await updates.snapshot();
    expect(snapshot.gatewayState).toBe("idle");
    expect(snapshot.checkError).toStartWith("GitHub is limiting update checks from this network. Next check at ");
    expect(snapshot.checking).toBe(false);
    expect(apiCalls).toBe(1);
  } finally {
    updates.close();
  }
});
