import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Histogram, addCount } from "./histogram.ts";
import { clientMetric, clientMetricIds, clientCounter, type ClientSource } from "./client-metrics.ts";

/** At most 24 fixed series. No thread IDs, URLs, payloads, disk buffer or retry queue. */
export class ClientMeasurements {
  enabled = true;
  readonly session: string;
  sequence = 0n;
  epoch = "";
  #start = Date.now();
  #minute = 0;
  #opens = 0;
  #values = new Map<number, { histogram: Histogram; events: bigint }>();
  readonly #ids: Set<number>;

  constructor(
    readonly source: ClientSource,
    session: string,
  ) {
    this.session = session;
    this.#ids = clientMetricIds(source);
  }

  opening(now = Date.now(), random = Math.random) {
    if (!this.enabled) return false;
    const minute = Math.floor(now / 60_000);

    if (minute !== this.#minute) {
      this.#minute = minute;
      this.#opens = 0;
    }

    if (this.#opens >= 20 || random() >= 0.1) return false;
    this.#opens++;

    return true;
  }

  record(metric: number, value: number) {
    const id = clientMetric(this.source, metric);
    this.recordId(id, value);
  }

  recordId(id: number, value: number) {
    if (!this.enabled) return;

    if (!this.#ids.has(id) || !Number.isFinite(value) || value < 0) return;
    let row = this.#values.get(id);

    if (!row) {
      row = { histogram: new Histogram(), events: 0n };
      this.#values.set(id, row);
    }

    row.events = addCount(row.events);
    row.histogram.record(value);
  }

  take(now = Date.now()) {
    // A suspended/offline client cannot re-date old observations into a fresh minute.
    if (now - this.#start > 120_000 || now < this.#start) this.#values.clear();

    const request = create(ui.SubmitDiagnosticsRequestSchema, {
      session: this.session,
      sequence: ++this.sequence,
      epoch: this.epoch,
      startMs: BigInt(Math.max(this.#start, now - 60_000)),
      endMs: BigInt(now),
      source: this.source,
      samplingRate: this.source === "bff" ? 1 : 0.1,
      measures: [...this.#values].map(([metricId, value]) =>
        create(ui.DiagnosticsMeasureAggregateSchema, {
          metricId,
          events: clientCounter(metricId) ? BigInt(Math.floor(value.histogram.sum)) : value.events,
          histogram: clientCounter(metricId) ? undefined : value.histogram.snapshot(),
          sampledAtMs: BigInt(now),
        }),
      ),
    });

    this.#start = now;
    this.#values.clear();

    return request;
  }

  clear(epoch = "") {
    this.#values.clear();
    this.#start = Date.now();
    this.epoch = epoch;
  }
}
