import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { update } from "@canopy/contracts";

export interface LivenessProbe {
  name: "web" | "gateway";
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

export function livenessProbes(web: string, gateway?: string): LivenessProbe[] {
  return [
    {
      name: "web",
      probe: async () => {
        const response = await fetch(`${web}/api/health`, { signal: AbortSignal.timeout(5000) });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      },
    },
    ...(gateway ? [{ name: "gateway" as const, probe: gatewayLiveness(gateway) }] : []),
  ];
}
