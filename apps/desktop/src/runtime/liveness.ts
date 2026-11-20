import { createClient } from "@connectrpc/connect";
import { createGrpcClientTransport } from "@canopy/transport";
import type { LocalBffTarget } from "@canopy/domain/bff-target";
import { update } from "@canopy/contracts";

export interface LivenessProbe {
  name: "gateway";
  probe: () => Promise<void>;
}

export function gatewayLiveness(target: LocalBffTarget) {
  // No authorization: authenticated Check also looks up the worker in the database.
  const client = createClient(
    update.UpdateService,
    createGrpcClientTransport({
      baseUrl: target.gatewayUrl,
      ca: target.certificate,
      fingerprint: target.fingerprint,
      connectTimeoutMs: 5000,
    }),
  );

  return async () => {
    const response = await client.check({}, { timeoutMs: 5000 });

    if (!response.healthy) throw new Error("Gateway is shutting down");
  };
}

/** The local gateway; the web runs in the controller itself (web.ts), so it has no separate liveness. */
export function livenessProbes(gateway: LocalBffTarget): LivenessProbe[] {
  return [{ name: "gateway", probe: gatewayLiveness(gateway) }];
}
