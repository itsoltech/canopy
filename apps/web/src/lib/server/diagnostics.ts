import { randomBytes } from "node:crypto";
import { Code, ConnectError, type Client } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { ClientMeasurements } from "@canopy/domain/diagnostics";
import { SubmitCooldown } from "#lib/shared/diagnostics-cooldown.ts";

export const bffMeasurements = new ClientMeasurements("bff", crypto.randomUUID());
const binding = randomBytes(32).toString("base64url");
let registered = false;
let pending = false;
const cooldown = new SubmitCooldown();

/** One bounded process collector and one timer; failures drop the batch instead of retaining a retry. */
/** `api` returns the current gateway client: a desktop BFF switches gateways without restarting. */
export function startBffDiagnostics(api: () => Client<typeof ui.GatewayService>) {
  if (registered) return;
  registered = true;

  const timer = setInterval(() => {
    if (pending || !cooldown.ready()) return;
    pending = true;
    void Promise.resolve()
      .then(() =>
        api().submitDiagnostics(bffMeasurements.take(), {
          headers: { "canopy-diagnostics-client": binding },
          timeoutMs: 5000,
        }),
      )
      .then((receipt) => {
        cooldown.succeeded();

        if (!receipt.accepted) bffMeasurements.clear(receipt.epoch);
      })
      .catch((cause) => {
        if (ConnectError.from(cause).code === Code.ResourceExhausted) cooldown.limited();
      })
      .finally(() => {
        pending = false;
      });
  }, 30_000);

  timer.unref();
}
