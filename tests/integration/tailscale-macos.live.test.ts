import { expect, test } from "bun:test";
import { MAC_APP_CLI } from "../../apps/gateway/src/network/tailscale/cli.ts";
import { Tailscale } from "../../apps/gateway/src/network/tailscale/tailscale.ts";

test.skipIf(process.platform !== "darwin" || process.env["CANOPY_LIVE"] !== "1")(
  "reads the running macOS Tailscale app directly from its bundle",
  async () => {
    const tailscale = new Tailscale({ path: "/usr/bin:/bin:/usr/sbin:/sbin" });
    const snapshot = await tailscale.refresh();

    expect(tailscale.cli).toBe(MAC_APP_CLI);
    expect(snapshot.state).toBe("connected");
  },
  10_000,
);
