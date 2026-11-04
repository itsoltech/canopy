import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@connectrpc/connect";
import { toJsonString } from "@bufbuild/protobuf";
import { Result } from "effect";
import { ui } from "@canopy/contracts";
import { createGrpcClientTransport, routedPinnedTransport } from "@canopy/transport";
import { parseLocalConfig } from "../../worker/src/config/local.ts";
import { endpointOptions } from "../../worker/src/network-route.ts";
import { readDesktopCredential, type DesktopClientCredential } from "./remote-client.ts";

/** Reuse only the saved worker trust; a response can supply routes, never weaken the pin. */
export async function migrateDesktopClient(folder: string): Promise<DesktopClientCredential | undefined> {
  const path = join(folder, "worker.json");

  if (!existsSync(path)) return undefined;
  const parsed = parseLocalConfig(readFileSync(path, "utf8"));

  if (Result.isFailure(parsed)) return undefined;
  const worker = parsed.success;
  const request = { workerId: worker.worker_id, platform: process.platform };
  let discovered: ui.MobileRoutes | undefined;

  for (const endpoint of [worker, ...(worker.gateway_fallback ? [worker.gateway_fallback] : [])]) {
    const url = new URL(endpoint.gateway_url);

    if (url.protocol !== "https:" && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) continue;

    try {
      const options = { timeoutMs: 3000, headers: { authorization: `Bearer ${worker.credential}` } };
      const old = createClient(ui.DesktopMigrationService, createGrpcClientTransport(endpointOptions(endpoint)));
      discovered = await old.getDesktopMigrationRoutes(request, options);
      break;
    } catch {
      // Discovery is read-only: an existing worker fallback may still be reachable.
    }
  }

  if (!discovered) return undefined;

  try {
    const pinned = createClient(
      ui.DesktopMigrationService,
      routedPinnedTransport(discovered, worker.credential).transport,
    );

    const result = await pinned.migrateDesktopClient(request, { timeoutMs: 5000 });

    return readDesktopCredential(toJsonString(ui.ExchangeMobilePairingResponseSchema, result));
  } catch {
    // A failed/lost mint is never replayed automatically on another endpoint.
    return undefined;
  }
}
