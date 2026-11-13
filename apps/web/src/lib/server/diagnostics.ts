import { randomBytes } from "node:crypto";
import type { Client } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { ClientMeasurements } from "@canopy/domain/diagnostics";

export const bffMeasurements = new ClientMeasurements("bff", crypto.randomUUID());
const binding = randomBytes(32).toString("base64url");
let registered = false;
let pending = false;

/** One bounded process collector and one timer; failures drop the batch instead of retaining a retry. */
export function startBffDiagnostics(api: Client<typeof ui.GatewayService>) {
  if (registered) return;
  registered = true;

  const timer = setInterval(() => {
    if (pending) return;
    pending = true;
    void api
      .submitDiagnostics(bffMeasurements.take(), { headers: { "canopy-diagnostics-client": binding }, timeoutMs: 5000 })
      .then((receipt) => {
        if (!receipt.accepted) bffMeasurements.clear(receipt.epoch);
      })
      .catch(() => {})
      .finally(() => {
        pending = false;
      });
  }, 30_000);

  timer.unref();
}
