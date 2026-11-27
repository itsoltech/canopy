import type { CoreRuntime } from "../core/core-context.ts";
import { decryptSecret } from "../store/secrets.ts";
import { readMobilePushBadge } from "./badge.ts";
import {
  claimPushDismissals,
  maxDismissedReceipts,
  recentPushDismissals,
  settlePushDismissal,
  type DismissalLease,
} from "./dismissal-store.ts";
import { pushGrantKey, type ManagedPushOptions } from "./managed-enrollment.ts";
import { invalidatePushGrant } from "./managed-store.ts";
import { encryptPushBadge } from "./previews.ts";
import { relayDismissal, type PushRelayOptions } from "./relay.ts";
import { expoTokenHash } from "./subscriptions.ts";

export type DismissalRelay = (
  | { kind: "manual"; options: PushRelayOptions & { secretsKey: Buffer } }
  | { kind: "managed"; options: ManagedPushOptions }
) & { abort: AbortController };

type Context = {
  runtime: CoreRuntime;
  owner: string;
  /** Orders settlement with a relay switch, like push delivery. */
  serial: <A>(run: () => Promise<A>) => Promise<A>;
  log?: ((message: string) => void) | undefined;
};

/** Sends one silent push per phone that lists the receipts it may remove from the lock screen. */
export async function dispatchPushDismissals(context: Context, relay: DismissalRelay) {
  const { runtime, owner } = context;
  const managedOrigin = relay.kind === "managed" ? relay.options.origin : undefined;
  const leases = await runtime.runPromise(claimPushDismissals(owner, managedOrigin));

  if (!leases.length) return;

  const badge = leases.some((lease) => lease.platform === "ios")
    ? await runtime.runPromise(readMobilePushBadge(owner)).catch(() => {
        context.log?.("Mobile push badge unavailable");

        return undefined;
      })
    : undefined;

  const results = await Promise.allSettled(leases.map((lease) => dismiss(context, relay, lease, badge)));

  if (results.some((result) => result.status === "rejected")) context.log?.("Mobile push dismissal deferred");
}

async function dismiss(context: Context, relay: DismissalRelay, lease: DismissalLease, badge: number | undefined) {
  const { runtime, owner } = context;
  const { signal } = relay.abort;
  const { secretsKey } = relay.options;
  const token = decryptSecret(secretsKey, lease.encrypted_token);
  const options = deliveryOptions(context, relay, lease, token);

  if (!options) {
    await runtime.runPromise(settlePushDismissal(owner, lease, "done"));

    return;
  }

  const earlier = await runtime.runPromise(recentPushDismissals(owner, lease, maxDismissedReceipts - lease.ids.length));

  const dismissId = crypto.randomUUID();
  const previewKey = Buffer.from(decryptSecret(secretsKey, lease.encrypted_preview_key), "base64url");

  const { outcome } = await relayDismissal(
    options,
    {
      token,
      platform: lease.platform,
      dismissId,
      receiptIds: [...lease.ids, ...earlier],
      ...(lease.platform === "ios" && badge !== undefined && { badge: encryptPushBadge(previewKey, dismissId, badge) }),
    },
    signal,
  );

  await context.serial(async () => {
    if (signal.aborted) return;

    if (outcome === "unauthorized" && lease.grant_id && lease.grant_expires_at)
      await runtime.runPromise(invalidatePushGrant(owner, lease.device_id, lease.grant_id, lease.grant_expires_at));

    await runtime.runPromise(settlePushDismissal(owner, lease, outcome === "unauthorized" ? "retry" : outcome));
  });
}

function deliveryOptions(context: Context, relay: DismissalRelay, lease: DismissalLease, token: string) {
  if (relay.kind === "manual") return relay.options;

  const { encrypted_bearer, expo_token_hash } = lease;

  if (!encrypted_bearer || !expo_token_hash) return;
  const tokenHash = Buffer.from(expo_token_hash);

  // The grant only covers the token it was issued for; a replaced token waits for a new grant.
  if (!expoTokenHash(token).equals(tokenHash)) return;

  const key = pushGrantKey(relay.options.secretsKey, context.owner, lease.device_id, {
    origin: relay.options.origin,
    platform: lease.platform,
    tokenHash,
  });

  return { ...relay.options, bearer: decryptSecret(key, encrypted_bearer) };
}
