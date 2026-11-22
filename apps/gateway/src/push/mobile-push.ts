import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { CoreRuntime, GatewayCoreOptions } from "../core/core-context.ts";
import { decryptSecret } from "../store/secrets.ts";
import { encryptPushPreview, readPushPreview } from "./previews.ts";
import { EXPO_TOKEN, PUSH_ID, PUSH_KEY, relayPush, type PushRelayOptions } from "./relay.ts";
import { loadPushRelaySettings, savePushRelaySettings, updatedRelayOptions } from "./relay-settings.ts";
import { claimPushJobs, livePushDelivery, resolveMobilePush, settlePushJob, type PushJob } from "./store.ts";
import {
  beginManagedMobilePush,
  completeManagedMobilePush,
  pushGrantKey,
  type ManagedPushOptions,
} from "./managed-enrollment.ts";
import { managedRelayOrigin, revokePushGrant } from "./managed-relay.ts";
import { invalidatePushGrant } from "./managed-store.ts";
import { claimPushRevocations, settlePushRevocation } from "./revocation-store.ts";
import { expoTokenHash, pushRegistration, setMobilePushSubscription } from "./subscriptions.ts";

export type MobilePushOptions = PushRelayOptions & { secretsKey: Buffer };

type ActiveRelay = (
  | { kind: "manual"; options: MobilePushOptions }
  | { kind: "managed"; options: ManagedPushOptions }
) & { abort: AbortController };

export class MobilePush {
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #intakeActive = false;
  #closed = false;
  readonly #shutdown = new AbortController();
  #relay: ActiveRelay | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  readonly #relaySettingsKey: Buffer | undefined;
  readonly #managed: ManagedPushOptions | undefined;

  static forGateway({ runtime, userId, managedMobilePush, relaySettingsKey, log }: GatewayCoreOptions) {
    return new MobilePush(runtime, userId, undefined, log, relaySettingsKey, managedMobilePush);
  }

  constructor(
    readonly runtime: CoreRuntime,
    readonly userId: string,
    options?: MobilePushOptions,
    readonly log?: (message: string) => void,
    relaySettingsKey?: Buffer,
    managed?: ManagedPushOptions,
  ) {
    this.#relaySettingsKey = relaySettingsKey;
    this.#managed = managed && { ...managed, origin: managedRelayOrigin(managed.origin) };
    this.#replaceRelay(options);
  }

  get manualAvailable() {
    return this.#relay?.kind === "manual";
  }

  get managedAvailable() {
    return this.#relay?.kind === "managed";
  }

  get settingsEditable() {
    return this.#relaySettingsKey !== undefined;
  }

  /** A saved choice takes priority over deployment defaults. */
  async initialize(deploymentDefaults?: () => PushRelayOptions | undefined) {
    const key = this.#relaySettingsKey;

    if (!key) return;

    const saved = await this.runtime.runPromise(loadPushRelaySettings(this.userId, key)).catch(() => {
      throw new Error("Could not load mobile push relay settings");
    });

    if (saved !== undefined || deploymentDefaults) {
      const selected = saved === undefined ? deploymentDefaults?.() : saved;
      this.#replaceRelay(selected ? { ...selected, secretsKey: key } : undefined);
    }
  }

  relaySettings() {
    const options = this.#relay?.kind === "manual" ? this.#relay.options : undefined;

    return create(ui.PushRelaySettingsSchema, {
      origin: options?.origin ?? "",
      hasPrivateCa: !!options?.ca,
      managedAvailable: this.#managed !== undefined,
    });
  }

  updateRelaySettings(input: ui.UpdatePushRelaySettingsRequest) {
    return this.#serial(async () => {
      const key = this.#relaySettingsKey;

      if (!key || this.#closed) throw new ConnectError("Push relay settings are unavailable", Code.Unavailable);
      const current = this.#relay?.kind === "manual" ? this.#relay.options : undefined;
      const next = updatedRelayOptions(input, current);
      const changed = next?.origin !== current?.origin || next?.bearer !== current?.bearer || next?.ca !== current?.ca;
      await this.runtime.runPromise(savePushRelaySettings(this.userId, key, next, current?.origin !== next?.origin));

      if (changed) {
        this.#replaceRelay(next && { ...next, secretsKey: key });
        this.#schedule();
      }

      return this.relaySettings();
    });
  }

  beginManaged(device: string, request: ui.BeginManagedMobilePushRequest, signal: AbortSignal) {
    const relay = this.#managedRelay();

    return beginManagedMobilePush(
      this.runtime,
      this.userId,
      relay.options,
      device,
      request,
      AbortSignal.any([signal, relay.abort.signal]),
    );
  }

  completeManaged(device: string, request: ui.CompleteManagedMobilePushRequest, signal: AbortSignal) {
    const relay = this.#managedRelay();

    return completeManagedMobilePush(
      this.runtime,
      this.userId,
      relay.options,
      device,
      request,
      AbortSignal.any([signal, relay.abort.signal]),
    );
  }

  subscribe(deviceId: string, { enabled, expoToken, previewKey }: ui.SetMobilePushSubscriptionRequest) {
    return this.#serial(async () => {
      const relay = this.#relay;

      if (enabled && !relay)
        throw new ConnectError("Push notifications are unavailable on this gateway", Code.Unavailable);

      if (enabled && (!EXPO_TOKEN.test(expoToken) || !PUSH_KEY.test(previewKey)))
        throw new ConnectError("Invalid push registration", Code.InvalidArgument);

      const registration =
        enabled && relay ? pushRegistration(relay.options.secretsKey, expoToken, previewKey) : undefined;

      const managed =
        enabled && relay?.kind === "managed"
          ? { origin: relay.options.origin, tokenHash: expoTokenHash(expoToken) }
          : undefined;

      const result = await this.runtime.runPromise(
        setMobilePushSubscription(this.userId, deviceId, registration, managed),
      );

      if (result === "device-unavailable") throw new ConnectError("Mobile device is unavailable", Code.Unauthenticated);

      if (result === "enrollment-required")
        throw new ConnectError("Start a new push enrollment and try again.", Code.FailedPrecondition);

      return create(ui.MobileOperationResponseSchema);
    });
  }

  async resolve(deviceId: string, receipt: string) {
    const job = PUSH_ID.test(receipt)
      ? await this.runtime.runPromise(resolveMobilePush(this.userId, deviceId, receipt))
      : undefined;

    if (!job) throw new ConnectError("Notification is no longer available", Code.NotFound);

    return create(ui.ResolveMobilePushResponseSchema, {
      destination: {
        case: job.event_kind === "turn" || job.event_kind === "interaction" ? "threadId" : "botId",
        value: job.destination_id,
      },
    });
  }

  start() {
    this.#intakeActive = true;
    this.#schedule();
  }

  #schedule() {
    if (!this.#intakeActive || !this.#relay || this.#timer || this.#closed) return;

    this.#timer = setInterval(() => {
      this.#running ??= this.dispatch()
        .catch(() => this.log?.("Mobile push processing deferred"))
        .finally(() => {
          this.#running = undefined;
        });
    }, 2000);
    this.#timer.unref();
  }

  async pause() {
    this.#intakeActive = false;
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#running;
  }

  async close() {
    this.#closed = true;
    this.#shutdown.abort();
    this.#replaceRelay(undefined);
    await this.pause();
    await this.#queue;
  }

  async dispatch() {
    const relay = this.#relay;

    if (!relay || relay.abort.signal.aborted) return;
    const results = await Promise.allSettled([this.#dispatchPushJobs(relay), this.#dispatchRevocations()]);

    if (results.some((result) => result.status === "rejected") && !this.#closed)
      this.log?.("Mobile push processing deferred");
  }

  async #dispatchPushJobs(relay: ActiveRelay) {
    const managedOrigin = relay.kind === "managed" ? relay.options.origin : undefined;
    const jobs = await this.runtime.runPromise(claimPushJobs(this.userId, managedOrigin));
    const results = await Promise.allSettled(jobs.map((job) => this.#deliver(relay, job)));

    if (results.some((result) => result.status === "rejected")) this.log?.("Mobile push settlement deferred");
  }

  async #dispatchRevocations() {
    const options = this.#managed;
    const signal = this.#shutdown.signal;

    if (!options || signal.aborted) return;
    const { origin, secretsKey } = options;
    const jobs = await this.runtime.runPromise(claimPushRevocations(this.userId, origin));

    const results = await Promise.allSettled(
      jobs.map(async (job) => {
        const key = pushGrantKey(secretsKey, this.userId, job.device_id, {
          origin,
          platform: job.platform,
          tokenHash: Buffer.from(job.expo_token_hash),
        });

        const bearer = decryptSecret(key, job.encrypted_bearer);

        if (await revokePushGrant(options, bearer, signal))
          await this.runtime.runPromise(settlePushRevocation(this.userId, job.id));
      }),
    );

    if (results.some((result) => result.status === "rejected") && !signal.aborted)
      this.log?.("Mobile push revocation deferred");
  }

  #replaceRelay(options: MobilePushOptions | undefined) {
    this.#relay?.abort.abort();
    const abort = new AbortController();
    this.#relay = this.#closed
      ? undefined
      : options
        ? { kind: "manual", options, abort }
        : this.#managed && { kind: "managed", options: this.#managed, abort };

    if (!this.#relay) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #serial<A>(run: () => Promise<A>) {
    const next = this.#queue.then(run);
    this.#queue = next.catch(() => {});

    return next;
  }

  #managedRelay() {
    const relay = this.#relay;

    if (relay?.kind !== "managed")
      throw new ConnectError("Managed push is unavailable on this gateway", Code.Unavailable);

    return relay;
  }

  async #deliver(relay: ActiveRelay, job: PushJob) {
    const {
      options,
      abort: { signal },
    } = relay;

    if (signal.aborted) return;
    const payload = job.ticket_id ? { ticketId: job.ticket_id } : await this.#payload(options.secretsKey, job);
    const credentials = await this.#deliveryCredentials(relay, job);

    if (signal.aborted || !credentials) return;

    if (
      payload &&
      "token" in payload &&
      credentials.grant &&
      !expoTokenHash(payload.token).equals(credentials.grant.tokenHash)
    )
      return;
    const outcome = payload ? await relayPush(credentials.options, payload, signal) : { outcome: "done" as const };

    // Order settlement with a settings switch so a response from the old relay cannot restore a retired ticket.
    await this.#serial(async () => {
      if (signal.aborted) return;
      const grant = credentials.grant;

      if (outcome.outcome === "unauthorized" && grant)
        await this.runtime.runPromise(invalidatePushGrant(this.userId, job.device_id, grant.id, grant.expiresAt));

      await this.runtime.runPromise(
        settlePushJob(this.userId, job, outcome.outcome === "unauthorized" ? { outcome: "retry" } : outcome),
      );
    });
  }

  async #deliveryCredentials(relay: ActiveRelay, job: PushJob) {
    const { options } = relay;

    const live = await this.runtime.runPromise(
      livePushDelivery(this.userId, job, relay.kind === "managed" ? options.origin : undefined),
    );

    if (!live) return;

    if (relay.kind === "manual") return { options: relay.options, grant: undefined };

    if (!live.encrypted_bearer || !live.expo_token_hash || !live.grant_id || !live.grant_expires_at) return;
    const tokenHash = Buffer.from(live.expo_token_hash);

    const key = pushGrantKey(options.secretsKey, this.userId, job.device_id, {
      origin: options.origin,
      platform: job.platform,
      tokenHash,
    });

    return {
      options: { ...options, bearer: decryptSecret(key, live.encrypted_bearer) },
      grant: { id: live.grant_id, expiresAt: live.grant_expires_at, tokenHash },
    };
  }

  async #payload(key: Buffer, job: PushJob) {
    const content = await this.runtime.runPromise(readPushPreview(this.userId, job));

    if (!content) return;
    const previewKey = Buffer.from(decryptSecret(key, job.encrypted_preview_key), "base64url");

    return {
      receiptId: job.id,
      platform: job.platform,
      token: decryptSecret(key, job.encrypted_token),
      preview: encryptPushPreview(previewKey, job.id, content),
    };
  }
}
