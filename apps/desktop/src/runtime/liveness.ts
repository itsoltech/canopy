import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { update } from "@canopy/contracts";

export interface LivenessProbe {
  name: "gateway";
  probe: () => Promise<void>;
}

export function gatewayLiveness(url: string) {
  // No authorization: authenticated Check also looks up the worker in the database.
  const client = createClient(update.UpdateService, createGrpcTransport({ baseUrl: url, connectTimeoutMs: 5000 }));

  return async () => {
    const response = await client.check({}, { timeoutMs: 5000 });

    if (!response.healthy) throw new Error("Gateway is shutting down");
  };
}

/** The local gateway; the web runs in the controller itself (web.ts), so it has no separate liveness. */
export function livenessProbes(gateway: string): LivenessProbe[] {
  return [{ name: "gateway", probe: gatewayLiveness(gateway) }];
}
