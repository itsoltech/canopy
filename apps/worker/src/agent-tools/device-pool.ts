import {
  abortable,
  DeviceBootNotStartedError,
  DeviceOwnership,
  matchesPlatform,
  DeviceWakeup,
  type Ownership,
} from "./device-pool-state.ts";

export { DeviceBootNotStartedError } from "./device-pool-state.ts";

export interface Device {
  id: string;
  name: string;
  platform: string;
  kind: "emulator" | "simulator" | "device";
  booted: boolean;
  busy?: boolean | undefined;
}

export interface DevicePoolBackend {
  devices(signal: AbortSignal): Promise<Device[]>;
  boot(device: Device, signal: AbortSignal): Promise<Device>;
  shutdown(device: Device, signal: AbortSignal): Promise<void>;
  closeSession?(session: string): Promise<void>;
}

interface AcquireInput {
  platform?: string | undefined;
  deviceId?: string | undefined;
  boot?: boolean;
  timeoutMs?: number;
  wait?: boolean;
}

interface Lease {
  key: string;
  device: Device;
  ready: boolean;
}

interface Session {
  controller: AbortController;
  fenced: boolean;
  uses: Set<Promise<void>>;
  pending?: Promise<Device>;
  selector?: AcquireInput;
  lease?: Lease;
  releasing?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

interface DevicePoolOptions {
  dataDir: string;
  backend: DevicePoolBackend;
  idleMs?: number;
}

export class DevicePool {
  readonly #backend: DevicePoolBackend;
  readonly #owned: DeviceOwnership;
  readonly #idleMs: number;
  readonly #sessions = new Map<string, Session>();
  readonly #leases = new Map<string, Lease>();
  readonly #cleaning = new Map<string, Promise<void>>();
  readonly #wakeup = new DeviceWakeup();
  #closed = false;
  #recovered = false;
  #recovery: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;

  constructor(options: DevicePoolOptions) {
    this.#backend = options.backend;
    this.#owned = new DeviceOwnership(options.dataDir);
    this.#idleMs = options.idleMs ?? 300_000;

    if (!Number.isFinite(this.#idleMs) || this.#idleMs <= 0) throw new Error("Invalid device idle timeout");
  }

  acquire(session: string, input: AcquireInput, signal: AbortSignal): Promise<Device> {
    try {
      const state = this.#session(session);
      this.#assertOpen(state);
      signal.throwIfAborted();
      const timeout = input.timeoutMs ?? 60_000;

      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid device acquisition timeout");
      const controller = new AbortController();

      const timer = setTimeout(
        () => controller.abort(new Error("Device acquisition timed out")),
        Math.min(timeout, 240_000),
      );

      const combined = AbortSignal.any([signal, controller.signal, state.controller.signal]);
      const task = this.#acquire(session, state, input, combined);

      return abortable(task, combined).finally(() => clearTimeout(timer));
    } catch (cause) {
      return Promise.reject(cause);
    }
  }

  async #acquire(session: string, state: Session, input: AcquireInput, signal: AbortSignal): Promise<Device> {
    if (state.releasing) await abortable(state.releasing, signal);
    this.#assertOpen(state);
    signal.throwIfAborted();

    if (state.lease && !state.lease.ready && !state.pending)
      throw new Error("Device cleanup is pending; release the session before acquiring again");

    if (state.lease?.ready) {
      this.#validate(state.lease, input);
      this.#touch(session, state);

      return { ...state.lease.device };
    }

    if (state.pending) {
      if (input.deviceId !== state.selector?.deviceId || input.platform !== state.selector?.platform)
        throw new Error("A different device acquisition is already pending for this session");

      return abortable(state.pending, signal);
    }

    const task = this.#allocate(session, state, input, signal);
    state.pending = task;
    state.selector = input;

    try {
      return await task;
    } finally {
      delete state.pending;
      delete state.selector;
    }
  }

  async #allocate(session: string, state: Session, input: AcquireInput, signal: AbortSignal): Promise<Device> {
    if (!this.#recovered) await abortable(this.recover(), signal);

    const admittedController = state.controller;
    let bootAttempted = false;

    try {
      for (;;) {
        signal.throwIfAborted();
        const version = this.#wakeup.version;
        const devices = await abortable(this.#backend.devices(signal), signal);
        signal.throwIfAborted();
        this.#assertOpen(state);

        const matching = devices.filter(
          (device) =>
            matchesPlatform(device.platform, input.platform) &&
            (!input.deviceId || input.deviceId === device.id || input.deviceId === device.name),
        );

        const known = [...this.#leases.values()].some(
          (lease) =>
            matchesPlatform(lease.device.platform, input.platform) &&
            (!input.deviceId ||
              input.deviceId === lease.key ||
              input.deviceId === lease.device.id ||
              input.deviceId === lease.device.name),
        );

        if (!matching.length && !known) throw new Error("No configured device matches the requested selector");
        const candidates = matching.filter((device) => this.#available(device, input));

        const device =
          candidates.find((candidate) => candidate.booted) ??
          candidates.find(
            (candidate) =>
              input.boot === true &&
              candidate.kind !== "device" &&
              [...this.#owned.entries.values()].filter((entry) => entry.stop).length < 2,
          );

        if (!device) {
          if (input.wait === false) throw new Error("No matching device is available; devices may be busy");
          await this.#wakeup.wait(signal, version);
          continue;
        }

        const lease: Lease = { key: device.id, device: { ...device }, ready: false };
        state.lease = lease;
        this.#leases.set(lease.key, lease);

        const owned: Ownership = { key: lease.key, session, stop: !device.booted, device: { ...device } };
        this.#owned.entries.set(lease.key, owned);
        this.#owned.save();

        if (!device.booted) {
          signal.throwIfAborted();
          bootAttempted = true;
          const booted = await this.#backend.boot({ ...device }, signal);

          if (booted.kind === "device" || !booted.booted || !matchesPlatform(booted.platform, input.platform))
            throw new Error("Device backend returned an invalid booted device");
          owned.device = { ...booted };
          lease.device = { ...booted };
          this.#owned.save();
        }

        signal.throwIfAborted();
        this.#assertOpen(state);
        lease.ready = true;
        this.#touch(session, state);

        return { ...lease.device };
      }
    } catch (cause) {
      const lease = state.lease;

      if (lease) {
        admittedController.abort(cause);

        try {
          const owned = this.#owned.entries.get(lease.key);

          if (owned && (cause instanceof DeviceBootNotStartedError || (!bootAttempted && !lease.ready))) {
            owned.stop = false;
            this.#owned.save();
          }

          await this.#cleanup(lease.key);
          this.#leases.delete(lease.key);
          delete state.lease;
          this.#wakeup.notify();

          if (!state.fenced && !state.releasing && state.controller === admittedController)
            state.controller = new AbortController();
        } catch {
          this.#scheduleRetry();
        }
      }

      throw cause;
    }
  }

  #available(device: Device, input: AcquireInput): boolean {
    if (device.busy || !matchesPlatform(device.platform, input.platform)) return false;

    if (input.deviceId && input.deviceId !== device.id && input.deviceId !== device.name) return false;

    for (const lease of this.#leases.values()) {
      if (lease.key === device.id || lease.device.id === device.id) return false;
    }

    for (const owned of this.#owned.entries.values()) {
      if (owned.key === device.id || owned.device.id === device.id) return false;
    }

    return device.booted || (input.boot === true && device.kind !== "device");
  }

  async use<T>(session: string, deviceId: string | undefined, work: (device: Device) => Promise<T>): Promise<T> {
    const state = this.#session(session);
    this.#assertOpen(state);
    const lease = state.lease;

    if (!lease?.ready || state.releasing || state.controller.signal.aborted)
      throw new Error("Acquire a device before using this session");
    this.#validate(lease, deviceId ? { deviceId } : {});
    clearTimeout(state.timer);
    const admittedSignal = state.controller.signal;

    const task = Promise.resolve().then(() => {
      this.#assertOpen(state);
      admittedSignal.throwIfAborted();

      if (state.releasing || state.lease !== lease || !lease.ready) throw new Error("Device session released");

      return work({ ...lease.device });
    });

    const done = task.then(
      () => undefined,
      () => undefined,
    );

    state.uses.add(done);

    try {
      return await task;
    } finally {
      state.uses.delete(done);

      if (!state.releasing) this.#touch(session, state);
    }
  }

  release(session: string): Promise<void> {
    const state = this.#sessions.get(session);

    if (!state) return Promise.resolve();

    if (state.releasing) return state.releasing;
    clearTimeout(state.timer);

    if (state.lease) state.lease.ready = false;
    const controller = state.controller;
    controller.abort(new Error("Device session released"));

    const task = this.#release(state).then(
      () => {
        delete state.releasing;

        if (!state.fenced && state.controller === controller) state.controller = new AbortController();
      },
      (cause: unknown) => {
        delete state.releasing;
        this.#scheduleRetry();
        throw cause;
      },
    );

    state.releasing = task;

    return task;
  }

  async #release(state: Session): Promise<void> {
    await Promise.allSettled([...(state.pending ? [state.pending] : []), ...state.uses]);
    const lease = state.lease;

    if (!lease) return;

    await this.#cleanup(lease.key);
    this.#leases.delete(lease.key);
    delete state.lease;
    this.#wakeup.notify();
  }

  fence(session: string): void {
    const state = this.#session(session);
    state.fenced = true;
    state.controller.abort(new Error("Device session is closed"));
    void this.release(session).catch(() => this.#scheduleRetry());
  }

  open(session: string): void {
    if (this.#closed) throw new Error("Device pool is closed");
    const state = this.#session(session);

    if (!state.fenced && !state.controller.signal.aborted) return;
    state.fenced = false;
    state.controller = new AbortController();
  }

  current(session: string): Device | undefined {
    const state = this.#sessions.get(session);

    return state?.lease?.ready && !state.releasing && !state.fenced ? { ...state.lease.device } : undefined;
  }

  canPreview(session: string, deviceId: string, platform: string): boolean {
    const current = this.current(session);

    if (current) return current.id === deviceId && current.platform === platform;

    if (this.#sessions.get(session)?.lease) return false;

    return ![...this.#owned.entries.values()].some((entry) => entry.key === deviceId || entry.device.id === deviceId);
  }

  recover(): Promise<void> {
    if (this.#recovery) return this.#recovery;
    const task = this.#recover();
    this.#recovery = task;
    void task
      .finally(() => {
        this.#recovery = undefined;
      })
      .catch(() => this.#scheduleRetry());

    return task;
  }

  async #recover(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.#owned.entries.keys()].map((key) => (this.#leases.has(key) ? Promise.resolve() : this.#cleanup(key))),
    );

    const failure = results.find((result) => result.status === "rejected");

    if (failure?.status === "rejected") throw failure.reason;
    this.#recovered = true;
  }

  #cleanup(key: string): Promise<void> {
    const pending = this.#cleaning.get(key);

    if (pending) return pending;
    const owned = this.#owned.entries.get(key);

    if (!owned) return Promise.resolve();
    const task = this.#shutdown(owned);
    this.#cleaning.set(key, task);
    void task.finally(() => this.#cleaning.delete(key)).catch(() => this.#scheduleRetry());

    return task;
  }

  async #shutdown(owned: Ownership): Promise<void> {
    await this.#backend.closeSession?.(owned.session);

    if (owned.stop) await this.#backend.shutdown({ ...owned.device }, AbortSignal.timeout(60_000));
    this.#owned.entries.delete(owned.key);

    try {
      this.#owned.save();
      this.#wakeup.notify();
    } catch (cause) {
      this.#owned.entries.set(owned.key, owned);
      throw cause;
    }
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    clearTimeout(this.#retry);

    for (const state of this.#sessions.values()) state.fenced = true;
    this.#closing = this.#close().catch((cause: unknown) => {
      this.#closing = undefined;
      throw cause;
    });

    return this.#closing;
  }

  async #close(): Promise<void> {
    const released = await Promise.allSettled([...this.#sessions.keys()].map((session) => this.release(session)));
    await this.recover();
    const failure = released.find((result) => result.status === "rejected");

    if (failure?.status === "rejected") throw failure.reason;
  }

  #session(session: string): Session {
    if (!session) throw new Error("Device session is required");
    let state = this.#sessions.get(session);

    if (!state) {
      state = { controller: new AbortController(), fenced: false, uses: new Set() };
      this.#sessions.set(session, state);
    }

    return state;
  }

  #assertOpen(state: Session): void {
    if (this.#closed || state.fenced) throw new Error("Device session is closed");
  }

  #validate(lease: Lease, input: AcquireInput): void {
    if (
      (input.deviceId &&
        input.deviceId !== lease.device.id &&
        input.deviceId !== lease.key &&
        input.deviceId !== lease.device.name) ||
      !matchesPlatform(lease.device.platform, input.platform)
    )
      throw new Error("Session already holds a different device; release it first");
  }

  #touch(session: string, state: Session): void {
    clearTimeout(state.timer);

    if (!state.uses.size) {
      state.timer = setTimeout(() => {
        void this.release(session).catch(() => this.#scheduleRetry());
      }, this.#idleMs);
      state.timer.unref();
    }
  }

  #scheduleRetry(): void {
    if (this.#closed || this.#retry) return;
    this.#retry = setTimeout(
      () => {
        this.#retry = undefined;

        for (const [session, state] of this.#sessions) {
          if (
            (state.controller.signal.aborted || (state.lease && !state.lease.ready && !state.pending)) &&
            !state.releasing
          )
            void this.release(session).catch(() => this.#scheduleRetry());
        }

        void this.recover().catch(() => this.#scheduleRetry());
      },
      Math.min(this.#idleMs, 1_000),
    );
    this.#retry.unref();
  }
}
