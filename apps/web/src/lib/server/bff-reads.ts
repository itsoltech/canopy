import {
  equals,
  toJson,
  toJsonString,
  type DescMessage,
  type JsonValue as ProtoJsonValue,
  type MessageShape,
} from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { QueryCache, QueryCacheDisposed } from "@canopy/domain/shared-query";
import { OverviewInvalidation } from "@canopy/domain/shared-query-events";
import { workerUpdateSignature } from "@canopy/domain/update-checks";

const MAX_ENTRIES = 64;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TRANSIENT = 128;
const encoder = new TextEncoder();

export type BffReadProjection =
  | { readonly key: string; readonly type: string; readonly value: ProtoJsonValue }
  | { readonly key: string; readonly reset: true; readonly prefix?: true };

type Listener = (frame: BffReadProjection) => void;

type Eviction = "capacity" | "oversized" | "private";

type Entry = {
  readonly key: string;
  stop: () => void;
  bytes: number;
  serialized: string;
  frame: Extract<BffReadProjection, { value: ProtoJsonValue }> | undefined;
};

/**
 * The BFF's owner-scoped, reactive read cache. Read closures stay at the route boundary so this class is usable by
 * both the embedded gateway web app and the desktop controller without importing gateway configuration.
 */
export class BffReads {
  readonly #queries = new QueryCache({ idle: MAX_ENTRIES });
  readonly #invalidation = new OverviewInvalidation(this.#queries);
  readonly #entries = new Map<string, Entry>();
  readonly #transient = new Map<string, boolean>();
  readonly #spilledPrefixes = new Set<string>();
  readonly #workers = new Map<string, string>();
  readonly #computers = new Map<string, ui.LinkedComputer>();
  readonly #listeners = new Set<Listener>();
  readonly #ended = Promise.withResolvers<never>();
  #encodedBytes = 0;
  #hasSnapshot = false;
  #privateGeneration = 0;
  #closed = false;

  constructor() {
    void this.#ended.promise.catch(() => {});
  }

  /** Reads a protobuf response once per key while it fits the bounded reactive cache. */
  async read<D extends DescMessage>(
    key: string,
    schema: D,
    fetch: () => Promise<MessageShape<D>>,
    maxAgeMs?: number,
  ): Promise<MessageShape<D>> {
    if (this.#closed) throw new QueryCacheDisposed();

    const privateGeneration = privateKey(key) ? this.#privateGeneration : undefined;

    if (this.#uncached(key)) {
      let result: MessageShape<D>;

      try {
        result = await this.#direct(fetch);
      } catch (cause) {
        this.#assertGeneration(privateGeneration);
        throw cause;
      }

      this.#assertGeneration(privateGeneration);

      return result;
    }

    if (this.#queries.snapshot<MessageShape<D>>(key).error) this.#queries.invalidate(key);

    let result: MessageShape<D>;

    try {
      result = await Promise.race([
        this.#queries.read<MessageShape<D>>(key, () => fetch(), maxAgeMs),
        this.#ended.promise,
      ]);
    } catch (cause) {
      this.#assertGeneration(privateGeneration);
      throw cause;
    }

    this.#assertGeneration(privateGeneration);
    const entry = this.#watch(key, schema, fetch);

    if (entry && !entry.frame) this.#publish(entry, schema, result);

    return result;
  }

  /** Applies one owner-scoped overview event to the shared reads. */
  apply(update: ui.OverviewUpdate, resetSnapshot = true): void {
    if (this.#closed || !update.change.case) return;
    const change = update.change;

    if (change.case === "mobileSnapshot") {
      this.#seedPresence(change.value.overview?.workers ?? [], change.value.overview?.computers ?? []);
      this.#invalidation.synced(
        change.value.overview?.workers ?? [],
        change.value.threads,
        resetSnapshot ? this.#hasSnapshot : true,
      );
      this.#hasSnapshot = true;

      if (resetSnapshot) {
        this.#resetPrivate();
        this.#invalidation.apply(update);
        this.#notifyTransient(change.case, update);
      }

      return;
    }

    if (this.#privateBoundary(change)) this.#resetPrivate();
    const presenceChanged = this.#presenceChanged(change);
    this.#invalidation.apply(update);
    this.#invalidateExtra(change.case, update, presenceChanged);
    this.#notifyTransient(change.case, update, presenceChanged);
  }

  /** Adds a route or connector notice invalidation to the same reactive cache. */
  invalidate(key: string): void {
    if (!this.#closed) this.#queries.invalidate(key);
  }

  /** Subscribes to complete projections and reset frames; ready projections replay immediately. */
  listen(listener: Listener): () => void {
    if (this.#closed) return () => {};

    this.#listeners.add(listener);

    for (const entry of this.#entries.values()) if (entry.frame) this.#emit(listener, entry.frame);

    return () => this.#listeners.delete(listener);
  }

  /** Ends the cache generation and fences every late fetch completion. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ended.reject(new QueryCacheDisposed());
    this.#queries.dispose();
    this.#entries.clear();
    this.#transient.clear();
    this.#spilledPrefixes.clear();
    this.#listeners.clear();
    this.#encodedBytes = 0;
  }

  #watch<D extends DescMessage>(key: string, schema: D, fetch: () => Promise<MessageShape<D>>): Entry | undefined {
    const existing = this.#entries.get(key);

    if (existing) {
      this.#touch(existing);

      return existing;
    }

    const entry: Entry = { key, stop: () => {}, bytes: 0, serialized: "", frame: undefined };
    const listener = () => this.#publishSnapshot(entry, schema);
    entry.stop = this.#queries.watch<MessageShape<D>>(key, () => fetch(), listener);
    this.#entries.set(key, entry);
    this.#transient.delete(key);
    this.#touch(entry);
    this.#trim(entry);

    return this.#entries.get(key) === entry ? entry : undefined;
  }

  #publishSnapshot<D extends DescMessage>(entry: Entry, schema: D): void {
    if (this.#closed || this.#entries.get(entry.key) !== entry) return;
    const snapshot = this.#queries.snapshot<MessageShape<D>>(entry.key);

    if (!snapshot.loaded || snapshot.loading || snapshot.stale || snapshot.error || !snapshot.data) return;
    this.#publish(entry, schema, snapshot.data);
  }

  #publish<D extends DescMessage>(entry: Entry, schema: D, data: MessageShape<D>): void {
    if (this.#entries.get(entry.key) !== entry) return;
    const serialized = toJsonString(schema, data);
    const bytes = encoder.encode(serialized).byteLength;

    if (bytes > MAX_BYTES) {
      this.#evict(entry, "oversized");

      return;
    }

    if (entry.serialized === serialized) {
      this.#touch(entry);

      return;
    }

    this.#encodedBytes -= entry.bytes;
    entry.bytes = bytes;
    entry.serialized = serialized;
    entry.frame = { key: entry.key, type: schema.typeName, value: toJson(schema, data) };
    this.#encodedBytes += bytes;
    this.#touch(entry);
    this.#trim(entry);

    if (this.#entries.get(entry.key) === entry && entry.frame)
      for (const listener of this.#listeners) this.#emit(listener, entry.frame);
  }

  #trim(preferred: Entry): void {
    while (this.#entries.size > MAX_ENTRIES || this.#encodedBytes > MAX_BYTES) {
      const candidate = [...this.#entries.values()].find((entry) => entry !== preferred) ?? preferred;
      this.#evict(candidate, "capacity");
    }
  }

  #evict(entry: Entry, reason: Eviction): void {
    if (this.#entries.get(entry.key) !== entry) return;
    this.#entries.delete(entry.key);
    this.#encodedBytes -= entry.bytes;
    entry.stop();
    entry.frame = undefined;
    entry.serialized = "";
    entry.bytes = 0;

    if (reason === "capacity" || reason === "oversized") this.#markTransient(entry.key, reason === "oversized");
    else this.#transient.delete(entry.key);

    this.#emitReset(entry.key);
    this.#queries.forget(entry.key);
  }

  #resetPrivate(): void {
    this.#privateGeneration++;

    for (const entry of this.#entries.values()) if (privateKey(entry.key)) this.#evict(entry, "private");

    this.#queries.forget((key) => privateKey(key));
  }

  #assertGeneration(generation: number | undefined): void {
    if (this.#closed || (generation !== undefined && generation !== this.#privateGeneration))
      throw new QueryCacheDisposed();
  }

  #invalidateExtra(
    change: NonNullable<ui.OverviewUpdate["change"]["case"]>,
    update: ui.OverviewUpdate,
    presenceChanged: boolean,
  ): void {
    if (change === "bot" || change === "botRemoved") this.#invalidateNamed("ListBots");

    if (change === "updatesChanged") this.#invalidateNamed("GetUpdates");

    if (change === "models") this.#invalidateNamed("ListModels");

    if (
      [
        "computer",
        "computerRemoved",
        "computerSnapshot",
        "desktopUpdate",
        "gatewayDeparture",
        "worker",
        "workerRemoved",
      ].includes(change) &&
      ((change !== "computer" && change !== "worker") || presenceChanged)
    )
      this.#invalidateNamed("GetUpdates");

    if (change === "linkedReadCompleted" && update.change.value === "GetComputerUpdates")
      this.#invalidateNamed("GetUpdates");
  }

  #invalidateNamed(prefix: string): void {
    this.#queries.invalidate((key) => named(key, prefix));
  }

  #notifyTransient(
    change: NonNullable<ui.OverviewUpdate["change"]["case"]>,
    update: ui.OverviewUpdate,
    presenceChanged = true,
  ): void {
    const kind = update.change;
    let matches: (key: string) => boolean = () => false;

    if (change === "thread") {
      const id = kind.case === "thread" ? kind.value.id : "";
      matches = (key) =>
        named(key, "GetPullRequest") ||
        named(key, `GetThreadPanel:${id}`) ||
        named(key, `ListThreadPullRequests:${id}`);
    } else if (change === "mobileSnapshot") matches = () => true;
    else if (["computerSnapshot", "computerRemoved"].includes(change))
      matches = (key) => privateKey(key) || named(key, "GetUpdates");
    else if (this.#privateBoundary(kind)) matches = privateKey;
    else if (change === "worker" && presenceChanged)
      matches = (key) => named(key, "GetThreadPanel") || named(key, "GetUpdates");
    else if (change === "bot" || change === "botRemoved") matches = (key) => named(key, "ListBots");
    else if (change === "updatesChanged") matches = (key) => named(key, "GetUpdates");
    else if (change === "computer" && presenceChanged)
      matches = (key) => named(key, "GetThreadPanel") || named(key, "GetUpdates");
    else if (["desktopUpdate", "gatewayDeparture"].includes(change)) matches = (key) => named(key, "GetUpdates");
    else if (change === "workerRemoved") matches = (key) => named(key, "GetThreadPanel") || named(key, "GetUpdates");
    else if (change === "sharedConfig" || change === "agentEnvironmentChanged")
      matches = (key) => named(key, "GetThreadPanel");
    else if (change === "models") matches = (key) => named(key, "ListModels");
    else if (change === "proxiesChanged" || change === "proxyAccounts") matches = (key) => named(key, "ListProxies");
    else if (change === "connectorsChanged") matches = (key) => named(key, "GetThreadPanel");
    else if (change === "schedule") matches = (key) => named(key, "GetThreadPanel");
    else if (change === "linkedReadCompleted") {
      const completed = kind.case === "linkedReadCompleted" ? kind.value : "";
      matches = (key) => named(key, completed) || (completed === "GetComputerUpdates" && named(key, "GetUpdates"));
    }

    for (const key of this.#transient.keys()) if (matches(key)) this.#emitReset(key);

    for (const prefix of this.#spilledPrefixes) {
      if (!matches(prefix) && !(change === "thread" && privateKey(prefix))) continue;
      this.#emitReset(prefix, true);
      this.#spilledPrefixes.delete(prefix);
    }
  }

  #privateBoundary(change: ui.OverviewUpdate["change"]): boolean {
    if (["computerSnapshot", "computerRemoved"].includes(change.case ?? "")) return true;

    if (change.case === "mobileDevice") return Boolean(change.value.revokedAt);

    if (change.case === "mobilePairing") return Boolean(change.value.revokedAt);

    return false;
  }

  #seedPresence(workers: readonly ui.Worker[], computers: readonly ui.LinkedComputer[]): void {
    this.#workers.clear();
    this.#computers.clear();

    for (const worker of workers) this.#workers.set(worker.id, workerUpdateSignature(worker));

    for (const computer of computers) this.#computers.set(computer.nodeId, withoutLastSeen(computer));
  }

  #presenceChanged(change: ui.OverviewUpdate["change"]): boolean {
    if (change.case === "worker") {
      const signature = workerUpdateSignature(change.value);
      const previous = this.#workers.get(change.value.id);
      this.#workers.set(change.value.id, signature);

      return previous !== undefined && previous !== signature;
    }

    if (change.case === "computer") {
      const current = withoutLastSeen(change.value);
      const previous = this.#computers.get(change.value.nodeId);
      this.#computers.set(change.value.nodeId, current);

      return previous === undefined || !equals(ui.LinkedComputerSchema, previous, current);
    }

    if (change.case === "workerRemoved") return this.#workers.delete(change.value);

    if (change.case === "computerRemoved") return this.#computers.delete(change.value);

    return true;
  }

  #uncached(key: string): boolean {
    const transient = this.#transient.get(key);

    if (transient === undefined) return false;

    if (!transient && this.#entries.size < MAX_ENTRIES) {
      this.#transient.delete(key);

      return false;
    }

    return true;
  }

  async #direct<D>(fetch: () => Promise<D>): Promise<D> {
    return Promise.race([fetch(), this.#ended.promise]);
  }

  #markTransient(key: string, oversized: boolean): void {
    this.#transient.delete(key);
    this.#transient.set(key, oversized);

    while (this.#transient.size > MAX_TRANSIENT) {
      const dropped = this.#transient.keys().next().value!;
      this.#transient.delete(dropped);
      const prefix = managedPrefix(dropped);

      if (prefix) this.#spilledPrefixes.add(prefix);
    }
  }

  #touch(entry: Entry): void {
    if (this.#entries.get(entry.key) !== entry) return;
    this.#entries.delete(entry.key);
    this.#entries.set(entry.key, entry);
  }

  #emitReset(key: string, prefix = false): void {
    const frame: BffReadProjection = prefix ? { key, reset: true, prefix: true } : { key, reset: true };

    for (const listener of this.#listeners) this.#emit(listener, frame);
  }

  #emit(listener: Listener, frame: BffReadProjection): void {
    try {
      listener(frame);
    } catch {
      // A browser subscriber cannot terminate the owner-scoped cache.
    }
  }
}

function named(key: string, prefix: string): boolean {
  return key.split("+").some((part) => part === prefix || part.startsWith(`${prefix}:`));
}

function managedPrefix(key: string): string | undefined {
  const separator = key.indexOf(":");
  const prefix = separator < 0 ? key : key.slice(0, separator);

  return [
    "GetPullRequest",
    "ListThreadPullRequests",
    "GetThreadPanel",
    "ListProxies",
    "ListModels",
    "ListBots",
    "GetUpdates",
  ].includes(prefix)
    ? prefix
    : undefined;
}

function withoutLastSeen(computer: ui.LinkedComputer): ui.LinkedComputer {
  return { ...computer, lastSeenMs: 0n };
}

function privateKey(key: string): boolean {
  return ["GetPullRequest", "ListThreadPullRequests", "GetThreadPanel"].some((prefix) => named(key, prefix));
}
