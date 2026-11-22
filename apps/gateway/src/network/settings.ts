import type { ComputerStore } from "../computers/store.ts";
import { NETWORK_KINDS, type NetworkKind } from "./addresses.ts";

export type NetworkSettings = {
  enabled: boolean;
  port: number | null;
  hostnames: string[];
  allowedNetworks: NetworkKind[];
};

export const defaultNetworkSettings = (): NetworkSettings => ({
  enabled: false,
  port: null,
  hostnames: [],
  allowedNetworks: [...NETWORK_KINDS],
});

/** The network access row of this gateway (migration 0055), owner-scoped like the computer identity. */
export async function loadSettings(store: ComputerStore): Promise<NetworkSettings> {
  const row = (
    await store.query<NetworkSettings>(
      `SELECT enabled, port, hostnames, allowed_networks AS "allowedNetworks"
       FROM network_access WHERE owner_user_id=$1::uuid`,
      [store.owner],
    )
  )[0];

  return row ?? defaultNetworkSettings();
}

export async function saveSettings(store: ComputerStore, settings: NetworkSettings) {
  await store.query(
    `INSERT INTO network_access (owner_user_id, enabled, port, hostnames, allowed_networks)
    VALUES ($1::uuid,$2,$3,$4::text[],$5::text[])
    ON CONFLICT (singleton) DO UPDATE SET enabled=excluded.enabled, port=excluded.port,
      hostnames=excluded.hostnames, allowed_networks=excluded.allowed_networks, updated_at=now()
    WHERE network_access.owner_user_id=excluded.owner_user_id`,
    [store.owner, settings.enabled, settings.port, settings.hostnames, settings.allowedNetworks],
  );
}
