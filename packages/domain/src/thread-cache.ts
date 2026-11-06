import { toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

/** Budget encoded bytes and count; the open screen owns its state independently of this LRU. */
export class ThreadCache {
  #entries = new Map<string, { snapshot: ui.ThreadSnapshot; bytes: number }>();
  #bytes = 0;

  constructor(readonly limits = { count: 12, bytes: 64 * 1024 * 1024 }) {}

  get(id: string): ui.ThreadSnapshot | undefined {
    const entry = this.#entries.get(id);

    if (!entry) return undefined;
    this.#entries.delete(id);
    this.#entries.set(id, entry);

    return entry.snapshot;
  }

  set(snapshot: ui.ThreadSnapshot, bytes = toBinary(ui.ThreadSnapshotSchema, snapshot).byteLength): void {
    const id = snapshot.thread?.id;

    if (!id) return;
    this.delete(id);

    if (snapshot.thread?.deletedAt || bytes > this.limits.bytes) return;
    this.#entries.set(id, { snapshot, bytes });
    this.#bytes += bytes;

    while (this.#entries.size > this.limits.count || this.#bytes > this.limits.bytes) {
      const oldest = this.#entries.keys().next().value;

      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  delete(id: string): void {
    this.#bytes -= this.#entries.get(id)?.bytes ?? 0;
    this.#entries.delete(id);
  }

  clear(): void {
    this.#entries.clear();
    this.#bytes = 0;
  }
}
