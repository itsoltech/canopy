import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

export const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
export const MAX_COUNT = 0xffff_ffff_ffff_ffffn;
const MAX_BUCKET = 0xffff_ffff;

export function addCount(left: bigint, right = 1n) {
  return left + right > MAX_COUNT ? MAX_COUNT : left + right;
}

export function addCounter(left: number, right = 1) {
  return Math.min(MAX_COUNTER, left + right);
}

/** Fixed time boundaries in milliseconds; bins 0/129 are underflow/overflow. */
export class Histogram {
  readonly indices: number[] = [];
  readonly counts: bigint[] = [];
  sum = 0;
  max = 0;
  min = Infinity;
  incomplete = false;

  constructor(
    readonly sizes = false,
    readonly wide = false,
    readonly reserve?: (bytes: number) => boolean,
  ) {}

  record(value: number) {
    if (!Number.isFinite(value) || value < 0) return;

    const index = this.sizes
      ? Math.min(31, value <= 1 ? 0 : Math.ceil(Math.log2(value)))
      : value < 0.001
        ? 0
        : Math.min(129, 1 + Math.max(0, Math.ceil(4 * Math.log2(value * 1000))));

    this.#add(index, 1n);

    this.sum = Math.min(Number.MAX_VALUE, this.sum + value);
    this.max = Math.max(this.max, value);
    this.min = Math.min(this.min, value);
  }

  merge(other: ui.DiagnosticsHistogram | Histogram) {
    for (let at = 0; at < other.indices.length; at++) {
      const index = other.indices[at]!;

      if (index < (this.sizes ? 32 : 130)) this.#add(index, other.counts[at] ?? 0n);
    }

    if (other instanceof Histogram) this.incomplete ||= other.incomplete;

    this.sum = Math.min(Number.MAX_VALUE, this.sum + other.sum);
    this.max = Math.max(this.max, other.max);

    if (other.counts.some((count) => count > 0n)) this.min = Math.min(this.min, other.min ?? 0);
  }

  #add(index: number, value: bigint) {
    if (!value) return;
    let at = this.indices.indexOf(index);

    if (at === -1) {
      if (this.reserve && !this.reserve(48)) {
        this.incomplete = true;

        return;
      }

      at = this.indices.findIndex((value) => value > index);

      if (at === -1) at = this.indices.length;
      this.indices.splice(at, 0, index);
      this.counts.splice(at, 0, 0n);
    }

    const limit = this.wide ? MAX_COUNT : BigInt(MAX_BUCKET);
    const count = this.counts[at]! + value;
    this.incomplete ||= count > limit;
    this.counts[at] = count > limit ? limit : count;
  }

  subtract(other: Histogram) {
    for (let i = 0; i < other.indices.length; i++) {
      const at = this.indices.indexOf(other.indices[i]!);

      if (at === -1) continue;
      const next = this.counts[at]! - other.counts[i]!;

      if (next > 0n) this.counts[at] = next;
      else {
        this.counts.splice(at, 1);
        this.indices.splice(at, 1);
      }
    }

    this.sum = Math.max(0, this.sum - other.sum);
  }

  snapshot() {
    return create(ui.DiagnosticsHistogramSchema, {
      indices: this.indices.slice(),
      counts: this.counts.slice(),
      sum: this.sum,
      max: this.max,
      min: Number.isFinite(this.min) ? this.min : undefined,
    });
  }
}

/** Merge counts before selecting exact 64-bit ranks, never averaging percentiles. */
export function percentiles(histograms: readonly ui.DiagnosticsHistogram[], sizes = false) {
  const counts = new BigUint64Array(sizes ? 32 : 130);
  let max = 0;
  let min = Infinity;
  let sum = 0;

  for (const histogram of histograms) {
    max = Math.max(max, histogram.max);

    if (histogram.counts.some((count) => count > 0n)) min = Math.min(min, histogram.min ?? 0);
    sum = Math.min(Number.MAX_VALUE, sum + histogram.sum);

    for (let at = 0; at < histogram.indices.length; at++) {
      const index = histogram.indices[at]!;

      if (index < counts.length) counts[index] = addCount(counts[index]!, histogram.counts[at] ?? 0n);
    }
  }

  const samples = counts.reduce((sum, n) => addCount(sum, n), 0n);

  let overflowQuantiles = 0;

  const quantile = (q: bigint, bit: number) => {
    let rank = (q * samples + 99n) / 100n;

    if (!samples) return 0;

    for (let index = 0; index < counts.length; index++) {
      rank -= counts[index]!;

      if (rank <= 0n) {
        const overflow = index === counts.length - 1;

        if (overflow) overflowQuantiles |= bit;

        const boundary = sizes
          ? 2 ** (overflow ? index - 1 : index)
          : index
            ? 0.001 * 2 ** ((Math.min(128, index) - 1) / 4)
            : 0.001;

        return Math.max(Math.min(min, max), Math.min(max, boundary));
      }
    }

    return max;
  };

  return create(ui.DiagnosticsPercentilesSchema, {
    p50: quantile(50n, 1),
    p95: quantile(95n, 2),
    p99: quantile(99n, 4),
    max,
    sum,
    samples: BigInt(samples),
    overflow: Boolean(counts[counts.length - 1]),
    overflowQuantiles,
  });
}
