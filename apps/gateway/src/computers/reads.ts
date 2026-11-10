import { fromBinary, toBinary, type DescMethod, type Message } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";
import {
  PEER_BACKOFF_MS,
  PEER_MAX_BACKOFF_MS,
  PEER_READ_REFRESH_MS,
  PEER_READ_RETRY_MS,
  PEER_READ_TIMEOUT_MS,
} from "./timing.ts";

type Entry = {
  node: string;
  value?: Uint8Array;
  next: number;
  failed: boolean;
  generation: number;
  method: DescMethod;
  load: (signal: AbortSignal) => Promise<Message>;
  timeoutMs: number;
  enabled: boolean;
  pending?: AbortController | undefined;
};

type Circuit = { failures: number; until: number };

export type PeerReadState = "loading" | "fresh" | "stale" | "unavailable";

const MAX_ENTRIES = 128;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_ACTIVE_PER_PEER = 4;

/** Bounded, single-flight background reads. A slow RPC cools down only that read; only a lost link opens the circuit. */
export class PeerReads {
  private entries = new Map<string, Entry>();
  private circuits = new Map<string, Circuit>();
  private tasks = new Set<Promise<void>>();
  private active = new Map<string, number>();
  private bytes = 0;
  private closed = false;
  private listeners = new Set<(method: string) => void>();

  subscribe(listener: (method: string) => void) {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  private key(node: string, method: DescMethod, request: Message) {
    return `${node} ${method.name} ${createHash("sha256").update(toBinary(method.input, request)).digest("hex")}`;
  }

  blocked(node: string) {
    return (this.circuits.get(node)?.until ?? 0) > Date.now();
  }

  disconnected(node: string) {
    if (this.blocked(node)) return;
    const failures = (this.circuits.get(node)?.failures ?? 0) + 1;
    this.circuits.set(node, {
      failures,
      until: Date.now() + Math.min(PEER_MAX_BACKOFF_MS, PEER_BACKOFF_MS * 2 ** (failures - 1)),
    });
  }

  connected(node: string) {
    this.circuits.delete(node);

    for (const entry of this.entries.values())
      if (entry.node === node) {
        entry.generation++;
        entry.failed = false;
        entry.next = 0;
      }
  }

  /** The node's reads of `method` are due now (it announced a change): the next read refreshes at once. */
  due(node: string, method: string) {
    for (const entry of this.entries.values()) if (entry.node === node && entry.method.name === method) entry.next = 0;
  }

  forget(node: string, methods?: ReadonlySet<string>) {
    if (!methods) this.circuits.delete(node);

    for (const [key, entry] of this.entries)
      if (entry.node === node && (!methods || methods.has(entry.method.name))) {
        entry.generation++;
        entry.enabled = false;
        entry.pending?.abort();
        this.bytes -= entry.value?.byteLength ?? 0;
        this.entries.delete(key);
      }
  }

  state(node: string, method: DescMethod, request: Message): PeerReadState {
    if (this.blocked(node)) return "unavailable";
    const entry = this.entries.get(this.key(node, method, request));

    if (!entry?.value) return entry?.failed ? "stale" : "loading";

    // A normal background refresh still serves the last successful snapshot. Only a failed
    // refresh makes it stale; otherwise every poll briefly adds and removes a waiting message.
    return entry.failed ? "stale" : "fresh";
  }

  /** Retain a completed explicit read for offline viewing, without scheduling periodic reads. */
  remember(node: string, method: DescMethod, request: Message, message: Message) {
    if (this.closed) return;
    const key = this.key(node, method, request);
    const previous = this.entries.get(key);
    const value = toBinary(method.output, message);

    if (value.byteLength > MAX_BYTES) return;

    while (
      this.entries.size >= MAX_ENTRIES ||
      this.bytes - (previous?.value?.byteLength ?? 0) + value.byteLength > MAX_BYTES
    ) {
      const oldest = [...this.entries].find(([id, entry]) => id !== key && !entry.pending);

      if (!oldest) return;
      this.bytes -= oldest[1].value?.byteLength ?? 0;
      this.entries.delete(oldest[0]);
    }

    previous?.pending?.abort();
    this.bytes += value.byteLength - (previous?.value?.byteLength ?? 0);
    this.entries.set(key, {
      node,
      method,
      value,
      generation: (previous?.generation ?? 0) + 1,
      next: Infinity,
      failed: false,
      timeoutMs: PEER_READ_TIMEOUT_MS,
      enabled: false,
      load: async () => message,
    });
  }

  read<A extends Message>(
    node: string,
    method: DescMethod,
    request: Message,
    load: (signal: AbortSignal) => Promise<A>,
    timeoutMs = PEER_READ_TIMEOUT_MS,
    enabled = true,
  ): A | undefined {
    const key = this.key(node, method, request);
    let entry = this.entries.get(key);

    if (!entry && !this.closed) {
      if (this.entries.size >= MAX_ENTRIES) {
        const oldest = [...this.entries].find(([, value]) => !value.pending);

        if (!oldest) return undefined;
        this.bytes -= oldest[1].value?.byteLength ?? 0;
        this.entries.delete(oldest[0]);
      }

      entry = { node, next: 0, failed: false, generation: 0, method, load, timeoutMs, enabled };
      this.entries.set(key, entry);
    }

    if (!entry) return undefined;
    entry.load = load;
    entry.enabled = enabled;

    if (
      enabled &&
      !this.closed &&
      !entry.pending &&
      !this.blocked(node) &&
      entry.next <= Date.now() &&
      (this.active.get(node) ?? 0) < MAX_ACTIVE_PER_PEER
    )
      this.refresh(entry, method, load, timeoutMs);

    // SAFETY: This entry's key includes the method; only its decoded output is stored by load.
    return entry.value ? (fromBinary(method.output, entry.value) as A) : undefined;
  }

  private refresh(
    entry: Entry,
    method: DescMethod,
    load: (signal: AbortSignal) => Promise<Message>,
    timeoutMs: number,
  ) {
    const controller = new AbortController();
    const generation = entry.generation;
    entry.pending = controller;
    this.active.set(entry.node, (this.active.get(entry.node) ?? 0) + 1);
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let changed = false;

    const task = (async () => {
      try {
        const value = toBinary(method.output, await load(controller.signal));

        if (entry.generation !== generation) return;

        if (controller.signal.aborted) {
          entry.failed = true;
          entry.next = Date.now() + PEER_READ_RETRY_MS;

          return;
        }

        const total = this.bytes - (entry.value?.byteLength ?? 0) + value.byteLength;
        changed = entry.failed || !entry.value || !sameBytes(entry.value, value);

        if (total <= MAX_BYTES) {
          this.bytes = total;
          entry.value = value;
        }

        entry.failed = false;
        entry.next = Date.now() + PEER_READ_REFRESH_MS;
      } catch {
        if (entry.generation === generation) {
          changed = !entry.failed;
          entry.failed = true;
          entry.next = Date.now() + PEER_READ_RETRY_MS;
        }
      } finally {
        clearTimeout(timer);
        entry.pending = undefined;
        this.active.set(entry.node, (this.active.get(entry.node) ?? 1) - 1);

        if (!this.closed && !this.blocked(entry.node))
          for (const waiting of this.entries.values()) {
            if ((this.active.get(entry.node) ?? 0) >= MAX_ACTIVE_PER_PEER) break;

            if (waiting.enabled && waiting.node === entry.node && !waiting.pending && waiting.next <= Date.now())
              this.refresh(waiting, waiting.method, waiting.load, waiting.timeoutMs);
          }

        // Only a read that changed what clients see is announced: an unchanged refresh triggers no client reads.
        if (!this.closed && changed)
          for (const listener of this.listeners) {
            try {
              listener(method.name);
            } catch {
              /* subscribers own their errors */
            }
          }
      }
    })();

    this.tasks.add(task);
    void task.then(() => this.tasks.delete(task));
  }

  async close() {
    this.closed = true;

    for (const entry of this.entries.values()) entry.pending?.abort();
    await Promise.allSettled(this.tasks);
    this.entries.clear();
    this.listeners.clear();
    this.circuits.clear();
    this.bytes = 0;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;

  for (let index = 0; index < a.byteLength; index++) if (a[index] !== b[index]) return false;

  return true;
}
