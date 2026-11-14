import { Code, ConnectError } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import { coreState } from "../core/core-context.ts";
import { settleDraftDelivery } from "./delivery-receipt.ts";
import { notifyDrafts } from "./events.ts";

const flights = new WeakMap<GatewayCore, Map<string, Promise<void>>>();

/** Only claim and settlement hold SQL transactions. Delivery, pump and remote I/O never do. */
export async function deliverDraft<A>(
  core: GatewayCore,
  id: string,
  prepare: () => Promise<{ sent: boolean; notify: boolean; attempt: string; active: boolean }>,
  send: () => Promise<A>,
): Promise<A> {
  const { actions } = core[coreState];

  const receipt = await actions.transaction(prepare);

  if (receipt.notify) notifyDrafts(core);

  if (receipt.sent) return send();
  const active = flights.get(core) ?? new Map<string, Promise<void>>();

  if (receipt.active) {
    const previous = active.get(id);

    if (!previous) throw new ConnectError("Send still in progress. Retry the same request.", Code.DeadlineExceeded);
    await previous;

    // Claim validates the request hash even for a concurrent retry. Recheck after settlement.
    return deliverDraft(core, id, prepare, send);
  }

  const completion = Promise.withResolvers<void>();
  active.set(id, completion.promise);
  flights.set(core, active);

  try {
    return await deliverClaimed(core, id, receipt.attempt, send);
  } finally {
    active.delete(id);
    completion.resolve();
  }
}

async function deliverClaimed<A>(core: GatewayCore, id: string, attempt: string, send: () => Promise<A>) {
  const { actions } = core[coreState];
  let result: A;

  try {
    result = await send();
  } catch (error) {
    const outcome = error instanceof ConnectError && uncertain(error) ? "unknown" : "rejected";

    if (await actions.transaction(() => settleDraftDelivery(core, id, attempt, outcome))) notifyDrafts(core);
    throw error;
  }

  try {
    await actions.transaction(() => settleDraftDelivery(core, id, attempt, "sent"));
  } catch {
    // Admission committed, so this cannot be reported as a definite rejection.
    // Keep recovery pending until its read-only check also repairs the receipt.
    throw new ConnectError("Send not confirmed. Retry with the same request.", Code.DeadlineExceeded);
  }

  return result;
}

function uncertain(error: ConnectError) {
  return (
    [Code.DeadlineExceeded, Code.Canceled, Code.Unknown].includes(error.code) ||
    (error.code === Code.Unavailable &&
      error.cause !== undefined &&
      error.metadata.get("canopy-error-scope") !== "computer")
  );
}
