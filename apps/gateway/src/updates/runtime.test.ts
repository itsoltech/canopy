import { expect, test } from "bun:test";
import { GatewayUpdates } from "./runtime.ts";

test("a persisted latest setting is rewritten as stable and remains stable for legacy requests", async () => {
  let stored = "latest";
  const updates = new GatewayUpdates({ kind: "source", version: "0.1.0", cacheDir: "/unused-update-cache",
    authenticate: async () => undefined,
    persistence: { admin: async () => true, channel: async () => stored, setChannel: async (value) => { stored = value; },
      workers: async () => [], hello: async () => {}, saveCommand: async () => {}, report: async () => {} },
    source: { fetch: async () => Response.json([]) },
  });
  try {
    await updates.start();
    expect(stored).toBe("stable");
    expect((await updates.snapshot()).channel).toBe("stable");
    // The gateway accepts old clients without retaining the obsolete setting.
    const { create } = await import("@bufbuild/protobuf");
    const { ui } = await import("@canopy/contracts");
    expect((await updates.manage(create(ui.ManageUpdatesRequestSchema, { action: "channel", channel: "latest" }))).channel).toBe("stable");
    expect(stored).toBe("stable");
  } finally { updates.close(); }
});
