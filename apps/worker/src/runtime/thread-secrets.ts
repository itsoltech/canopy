import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { create } from "@bufbuild/protobuf";
import { ItemDeltaField, ThreadSecretReceiptSchema, type ThreadSecretDelivery, type ThreadSecretReceipt } from "@open-agents/contracts";
import type { ThreadEventInit } from "../journal/journal.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const activeStores = new Set<ThreadSecretFiles>();

/** Before durable events are written. Deltas are withheld while a secret is live: a value
 * split across chunks cannot be safely masked one chunk at a time. Completed items carry full output. */
export function secretEventRedactor(): (threadId: string, event: ThreadEventInit) => ThreadEventInit {
  const buffers = new Map<string, { chunks: Map<number, string>; values: Set<string> }>();
  return (threadId, event) => {
  const body = event.body;
  const itemId = body?.case === "itemDelta" ? body.value.itemId : body?.case === "itemCompleted" ? body.value.item?.itemId : undefined;
  const key = `${threadId}/${itemId}`;
  const buffered = buffers.get(key);
  const values = [...new Set([...activeStores].flatMap((s) => s.redactionValues()).concat([...(buffered?.values ?? [])]))];
  if (!values.length) return event;
  if (body?.case === "itemDelta") {
    const buffer = buffered ?? { chunks: new Map<number, string>(), values: new Set<string>() };
    const field = body.value.field ?? 0;
    const previous = buffer.chunks.get(field) ?? "";
    buffer.chunks.set(field, previous.length < 4 * 1024 * 1024 ? previous + (body.value.chunk ?? "") : "[Output withheld: too large to redact]");
    for (const value of values) buffer.values.add(value);
    buffers.set(key, buffer);
  }
  if (body?.case === "itemCompleted" && buffered) {
    event = structuredClone(event);
    const item = event.body?.case === "itemCompleted" ? event.body.value.item : undefined;
    const content = item?.content;
    if (content?.case === "agentMessage" || content?.case === "reasoning") {
      if (!content.value.text) content.value.text = buffered.chunks.get(ItemDeltaField.TEXT) ?? "";
    }
    if (content?.case === "reasoning" && !content.value.summary) content.value.summary = buffered.chunks.get(ItemDeltaField.SUMMARY) ?? "";
    if (content?.case === "commandExecution" || content?.case === "toolCall" || content?.case === "backgroundTask") {
      if (!content.value.output) content.value.output = buffered.chunks.get(ItemDeltaField.OUTPUT) ?? "";
    }
    buffers.delete(key);
  }
  const patterns = [...new Set(values.flatMap((value) => [value, JSON.stringify(value).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") {
      for (const pattern of patterns) value = (value as string).split(pattern).join("[REDACTED]");
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object" && !(value instanceof Uint8Array)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
    return value;
  };
  const safe = redact(event) as ThreadEventInit;
  safe.rawJson = "";
  if (safe.body?.case === "itemDelta") safe.body.value.chunk = "";
  if (safe.body?.case === "turnFinished") for (const id of buffers.keys()) if (id.startsWith(`${threadId}/`)) buffers.delete(id);
  return safe;
  };
}

/** Private materializations, never inside the workspace or the provider's environment. */
export class ThreadSecretFiles {
  readonly root: string;
  readonly #entries = new Map<string, { revision: number; file: string; timer?: ReturnType<typeof setTimeout>; value: string }>();
  constructor(dataDir: string) {
    this.root = join(resolve(dataDir), "thread-secrets");
    mkdirSync(resolve(dataDir), { recursive: true, mode: 0o700 });
    if (existsSync(this.root)) {
      if (lstatSync(this.root).isSymbolicLink() || !lstatSync(this.root).isDirectory()) throw new Error("unsafe thread secrets directory");
      // A fresh process has no grants yet. The gateway re-delivers only unexpired values.
      rmSync(this.root, { recursive: true, force: true });
    }
    mkdirSync(this.root, { mode: 0o700 });
    chmodSync(this.root, 0o700);
    activeStores.add(this);
  }
  threadDir(threadId: string): string {
    if (!UUID.test(threadId)) throw new Error("invalid thread secret owner");
    const dir = join(this.root, threadId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) throw new Error("unsafe thread secrets directory");
    chmodSync(dir, 0o700);
    return dir;
  }
  redactionValues(): string[] { return [...this.#entries.values()].flatMap((e) => e.value ? [e.value] : []); }
  apply(delivery: ThreadSecretDelivery): ThreadSecretReceipt {
    const receipt = create(ThreadSecretReceiptSchema, {
      requestId: delivery.requestId, threadId: delivery.threadId, revision: delivery.revision,
    });
    try {
      if (!UUID.test(delivery.requestId) || !UUID.test(delivery.threadId) || delivery.revision < 1) return receipt;
      const key = `${delivery.threadId}/${delivery.requestId}`;
      const previous = this.#entries.get(key);
      if (previous && previous.revision > delivery.revision) return receipt;
      const file = join(this.threadDir(delivery.threadId), delivery.requestId);
      const expires = delivery.expiresAt ? timestampDate(delivery.expiresAt).getTime() : 0;
      if (delivery.remove || expires <= Date.now()) {
        if (previous?.timer) clearTimeout(previous.timer);
        rmSync(file, { force: true });
        this.#entries.set(key, { revision: delivery.revision, file, value: "" });
        receipt.applied = true;
        return receipt;
      }
      if (!delivery.cwd) return receipt;
      const cwd = existsSync(delivery.cwd) ? realpathSync(delivery.cwd) : resolve(delivery.cwd);
      const within = relative(cwd, realpathSync(this.root));
      if (!within || (!within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && within !== ".." && !isAbsolute(within))) return receipt;
      if (previous?.revision === delivery.revision && existsSync(file)) {
        receipt.applied = true; receipt.file = file; return receipt;
      }
      const dir = this.threadDir(delivery.threadId);
      mkdirSync(dir, { mode: 0o700, recursive: true });
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) return receipt;
      chmodSync(dir, 0o700);
      const partial = join(dir, `${delivery.requestId}.${crypto.randomUUID()}.partial`);
      const fd = openSync(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        try { writeFileSync(fd, delivery.value, "utf8"); }
        finally { closeSync(fd); }
        renameSync(partial, file);
      }
      finally { rmSync(partial, { force: true }); }
      if (previous?.timer) clearTimeout(previous.timer);
      const entry = { revision: delivery.revision, file, value: delivery.value, timer: setTimeout(() => {
        try { rmSync(file, { force: true }); } catch { /* A subsequent gateway synchronization retries cleanup. */ }
        const current = this.#entries.get(key);
        if (current?.revision === delivery.revision) current.value = "";
      }, Math.min(expires - Date.now(), 2_147_483_647)) };
      entry.timer.unref();
      this.#entries.set(key, entry);
      receipt.applied = true; receipt.file = file;
    } catch { /* Do not attach a delivery, its value, or an exception to diagnostics. */ }
    return receipt;
  }
  close(): void {
    activeStores.delete(this);
    for (const entry of this.#entries.values()) if (entry.timer) clearTimeout(entry.timer);
    this.#entries.clear();
    for (const name of readdirSync(this.root)) rmSync(join(this.root, name), { recursive: true, force: true });
  }
}
