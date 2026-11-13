import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { addSampleCount, Histogram, MAX_COUNT } from "./histogram.ts";

/** No per-sample objects, code arrays or unused histograms for internal measurements. */
export class Measure {
  histogram: Histogram | undefined;
  #events: number | bigint = 0;
  #errors: number | bigint = 0;
  weightedSum = 0;
  weight = 0;
  max = 0;
  last = 0;
  #sampledAtMs: number | bigint = 0;
  incomplete = false;

  constructor(readonly reserve?: (bytes: number) => boolean) {}

  get events() {
    return BigInt(this.#events);
  }

  get errors() {
    return BigInt(this.#errors);
  }

  get sampledAtMs() {
    return BigInt(this.#sampledAtMs);
  }

  get bytes() {
    return 256 + (this.histogram ? 144 + this.histogram.indices.length * 48 : 0);
  }

  timing(value: number, error: boolean, at: number) {
    this.counter(1, error, at);

    if (!this.histogram) {
      if (this.reserve && !this.reserve(144)) {
        this.incomplete = true;

        return;
      }

      this.histogram = new Histogram(false, true, this.reserve);
    }

    this.histogram.record(value);
  }

  counter(count: number, error: boolean, at: number) {
    this.#events = addSampleCount(this.#events, count);

    if (error) this.#errors = addSampleCount(this.#errors, count);
    this.#sampledAtMs = Math.floor(at);
    this.incomplete ||= this.#events === MAX_COUNT || this.#errors === MAX_COUNT;
  }

  gauge(value: number, weight: number, at: number) {
    this.#weight(value * weight, weight);
    this.max = Math.max(this.max, value);
    this.last = value;
    this.#sampledAtMs = Math.floor(at);
    this.#events = addSampleCount(this.#events);
    this.incomplete ||= this.#events === MAX_COUNT;
  }

  merge(value: ui.DiagnosticsMeasureAggregate | Measure) {
    if (value.histogram) {
      if (!this.histogram) {
        if (this.reserve && !this.reserve(144)) {
          this.incomplete = true;
        } else this.histogram = new Histogram(false, true, this.reserve);
      }

      this.histogram?.merge(value.histogram);
    }

    this.#events = addSampleCount(this.#events, value instanceof Measure ? value.#events : value.events);
    this.#errors = addSampleCount(this.#errors, value instanceof Measure ? value.#errors : value.errors);
    this.#weight(value.weightedSum, value.weight);
    this.max = Math.max(this.max, value.max);

    if (value.sampledAtMs >= this.sampledAtMs) {
      this.last = value.last;
      this.#sampledAtMs = value.sampledAtMs;
    }

    this.incomplete ||=
      value.incomplete ||
      this.#events === MAX_COUNT ||
      this.#errors === MAX_COUNT ||
      Boolean(this.histogram?.incomplete);
  }

  snapshot(metricId: number, rpcMethodId = 0) {
    return create(ui.DiagnosticsMeasureAggregateSchema, {
      metricId,
      rpcMethodId,
      histogram: this.histogram?.snapshot(),
      events: this.events,
      errors: this.errors,
      weightedSum: this.weightedSum,
      weight: this.weight,
      max: this.max,
      last: this.last,
      sampledAtMs: this.sampledAtMs,
      incomplete: this.incomplete || Boolean(this.histogram?.incomplete),
    });
  }

  #weight(sum: number, weight: number) {
    const next = this.weightedSum + sum;
    const duration = this.weight + weight;
    this.incomplete ||= !Number.isFinite(next) || !Number.isFinite(duration);
    this.weightedSum = Number.isFinite(next) ? next : Number.MAX_VALUE;
    this.weight = Number.isFinite(duration) ? duration : Number.MAX_VALUE;
  }
}

export const measureKey = (metric: number, rpc = 0) => metric * 0x1_0000_0000 + rpc;
export const metricOf = (key: number) => Math.floor(key / 0x1_0000_0000);
export const rpcOf = (key: number) => key % 0x1_0000_0000;
