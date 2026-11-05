import { Option } from "effect";
import type { JsonValue } from "@canopy/domain";
import type { ComputerStore } from "../../computers/store.ts";
import { decodeEntry, type ServeEntry } from "./serve.ts";

/** HTTPS over Tailscale in the network access row (migration 0083). */
export type HttpsSettings = {
  enabled: boolean;
  /** The HTTPS port chosen in Settings; null = automatic. */
  port: number | null;
  /** The loopback port of the front, kept so the Serve entry stays valid across restarts. */
  frontPort: number | null;
  /** Exactly what Canopy added to Serve and has not removed yet. */
  serve: ServeEntry | null;
};

export const NO_HTTPS: HttpsSettings = { enabled: false, port: null, frontPort: null, serve: null };

type Row = {
  tailscale_https: boolean;
  tailscale_https_port: number | null;
  tailscale_front_port: number | null;
  tailscale_serve: JsonValue;
};

export async function loadHttpsSettings(store: ComputerStore): Promise<HttpsSettings> {
  const row = (
    await store.query<Row>(
      `SELECT tailscale_https, tailscale_https_port, tailscale_front_port, tailscale_serve
      FROM network_access WHERE owner_user_id=$1::uuid`,
      [store.owner],
    )
  )[0];

  if (!row) return NO_HTTPS;

  return {
    enabled: row.tailscale_https,
    port: row.tailscale_https_port,
    frontPort: row.tailscale_front_port,
    serve: row.tailscale_serve === null ? null : Option.getOrNull(decodeEntry(row.tailscale_serve)),
  };
}

/** Writes only the Tailscale columns; the rest of the row belongs to network access. */
export async function saveHttpsSettings(store: ComputerStore, settings: HttpsSettings) {
  await store.query(
    `INSERT INTO network_access (owner_user_id, tailscale_https, tailscale_https_port, tailscale_front_port, tailscale_serve)
    VALUES ($1::uuid,$2,$3,$4,$5::jsonb)
    ON CONFLICT (singleton) DO UPDATE SET tailscale_https=excluded.tailscale_https,
      tailscale_https_port=excluded.tailscale_https_port, tailscale_front_port=excluded.tailscale_front_port,
      tailscale_serve=excluded.tailscale_serve, updated_at=now()
    WHERE network_access.owner_user_id=excluded.owner_user_id`,
    [
      store.owner,
      settings.enabled,
      settings.port,
      settings.frontPort,
      settings.serve ? JSON.stringify(settings.serve) : null,
    ],
  );
}
