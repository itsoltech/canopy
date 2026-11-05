import type { ConnectRouter } from "@connectrpc/connect";
import { LinkedComputers } from "../../../apps/gateway/src/computers/runtime.ts";
import { linkHandler } from "../../../apps/gateway/src/computers/transport.ts";
import { openListener } from "../../../apps/gateway/src/network/listener.ts";
import type { Options } from "../../../apps/gateway/src/computers/runtime-context.ts";
import type { DetectedAddress } from "../../../apps/gateway/src/network/addresses.ts";
import { NetworkAccess } from "../../../apps/gateway/src/network/network.ts";
import type { Tailscale } from "../../../apps/gateway/src/network/tailscale/tailscale.ts";

export type TestComputerOptions = Omit<Options, "network"> & {
  /** One loopback address, or "0.0.0.0" with `detect` for a computer on every interface. */
  host: string;
  /** A fixed port; 0 or none = chosen by network access and kept in the database. */
  port?: number;
  detect?: () => DetectedAddress[];
  tailscale?: Tailscale;
};

/** Linked computers on their own network access listener, switched on, as a computer with
 * "Let phones and other computers connect" on. Closing them closes the listener too. */
export function linkedComputers({ host, port, detect, tailscale, ...options }: TestComputerOptions) {
  const network = new NetworkAccess({
    role: "desktop",
    store: options.store,
    host,
    ...(port && { port }),
    ...(detect && { detect }),
    ...(tailscale && { tailscale }),
    pollMs: 200,
  });

  const computers = new LinkedComputers({ ...options, network });
  const start = computers.start.bind(computers);
  const close = computers.close.bind(computers);

  computers.start = async () => {
    await options.store.query(
      `INSERT INTO network_access (owner_user_id, enabled) VALUES ($1::uuid, true)
      ON CONFLICT (singleton) DO UPDATE SET enabled = true`,
      [options.store.owner],
    );
    await start();
    await network.start();
  };

  computers.close = async (state) => {
    await close(state);
    await network.close();
  };

  return computers;
}

/** A bare link service with its own identity on a port (a false route, a man in the middle). */
export function listenLink(options: {
  host: string;
  port: number;
  identity: { certificate: string; privateKey: string };
  routes: (router: ConnectRouter) => void;
}) {
  const handler = linkHandler(options.routes);

  return openListener({ host: options.host, port: options.port, identity: options.identity, route: () => handler });
}
