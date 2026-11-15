import { create, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { AsyncChannel } from "@canopy/transport";
import { BffOverview } from "./bff-overview.ts";
import { BffReads, type BffReadProjection } from "./bff-reads.ts";
import { BffWarming } from "./bff-warming.ts";
import type { Client } from "@connectrpc/connect";

export type BffEvent =
  | { kind: "overview"; update: ui.OverviewUpdate; revision: number }
  | { kind: "read-model"; projection: BffReadProjection };

/** A single authenticated owner and gateway target: never shared across connection generations. */
export class BffSession {
  readonly overview: BffOverview;
  readonly reads = new BffReads();
  readonly warming: BffWarming;
  readonly #leases = new Map<symbol, { ids: readonly string[]; active: string }>();
  readonly #stop: () => void;
  readonly #streams = new Set<AsyncChannel<BffEvent>>();
  #closed = false;
  #snapshotRevision: number | undefined;

  constructor(readonly api: Client<typeof ui.GatewayService>) {
    this.overview = new BffOverview(api);
    this.warming = new BffWarming(api, (id, update) => this.threadChanged(id, update));
    this.#stop = this.overview.listen((update) => {
      const generation = this.warming.generation;
      this.warming.apply(update);

      if (update.change.case === "mobileSnapshot") {
        const reset = this.#snapshotRevision !== this.overview.revision || generation !== this.warming.generation;
        this.#snapshotRevision = this.overview.revision;
        this.reads.apply(update, reset);
      } else this.reads.apply(update);
    });
  }

  threadChanged(id: string, update: ui.ThreadUpdate) {
    const change = update.change;

    const notices =
      change.case === "batch"
        ? change.value.records.flatMap((record) => (record.value.case === "notice" ? [record.value.value.notice] : []))
        : change.case === "event" && change.value.event?.body.case === "notice"
          ? [change.value.event.body.value]
          : [];

    if (
      notices.some(
        (notice) => notice && ["connectors_baseline", "connectors_applied", "connectors_failed"].includes(notice.code),
      )
    )
      this.reads.invalidate(`GetThreadPanel:${id}`);
  }

  #select() {
    if (this.#closed) return;
    const leases = [...this.#leases.values()];
    const active = new Set(leases.flatMap((lease) => (lease.active ? [lease.active] : [])));
    const ids = [...new Set(leases.flatMap((lease) => lease.ids))].filter((id) => !active.has(id)).slice(0, 32);
    this.warming.select(ids);
  }

  async *subscribe(ids: readonly string[], active: string, signal: AbortSignal): AsyncGenerator<BffEvent> {
    if (this.#closed || this.#leases.size >= 32)
      throw new ConnectError("Read model subscriptions unavailable", Code.ResourceExhausted);

    const channel = new AsyncChannel<BffEvent>({
      maxItems: 256,
      maxBytes: 8 * 1024 * 1024,
      overflow: () => new Error("Read model stream fell behind"),
    });

    const abort = new AbortController();

    const stop = () => {
      abort.abort();
      channel.close();
    };

    const lease = Symbol();
    this.#streams.add(channel);
    this.#leases.set(lease, { ids: ids.slice(0, 32), active });
    this.#select();
    this.warming.warmer.yieldToNavigation();
    signal.addEventListener("abort", stop, { once: true });

    const receive = (projection: BffReadProjection) => {
      if (!channel.push({ kind: "read-model", projection }, Buffer.byteLength(JSON.stringify(projection))))
        abort.abort();
    };

    let unlisten: (() => void) | undefined;

    const pump = (async () => {
      try {
        for await (const update of this.overview.subscribe(ids, abort.signal)) {
          if (
            !channel.push(
              { kind: "overview", update, revision: this.overview.revision },
              toBinary(ui.OverviewUpdateSchema, update).length,
            )
          )
            break;

          if (update.change.case === "mobileSnapshot") unlisten ??= this.reads.listen(receive);
        }

        channel.close();
      } catch (cause) {
        channel.close(cause);
      }
    })();

    try {
      if (signal.aborted) stop();

      for await (const frame of channel) {
        if (this.#closed || signal.aborted) break;
        yield frame;
      }
    } finally {
      stop();
      unlisten?.();
      signal.removeEventListener("abort", stop);
      this.#streams.delete(channel);
      this.#leases.delete(lease);
      this.#select();
      await pump;
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;

    for (const channel of this.#streams) channel.close();
    this.#leases.clear();
    this.#stop();
    this.reads.close();
    this.warming.close();
    this.overview.close();
  }

  async thread(id: string) {
    this.warming.warmer.yieldToNavigation();
    const thread = await this.overview.thread(id);

    return thread ? create(ui.GetThreadResponseSchema, { thread }) : this.api.getThread({ threadId: id });
  }
}
