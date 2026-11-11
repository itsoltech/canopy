import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

export const MAX_COUNTER = Number.MAX_SAFE_INTEGER;
export const MAX_COUNT = 0xffff_ffff_ffff_ffffn;
const MAX_BUCKET = 0xffff_ffff;

export function addCount(left: bigint, right = 1n) {
  const next = left + right;

  return next > MAX_COUNT ? MAX_COUNT : next;
}

export function addCounter(left: number, right = 1) {
  return Math.min(MAX_COUNTER, left + right);
}

/** Stay allocation-free until the exact integer range is exhausted, then retain uint64 precision. */
export function addSampleCount(left: number | bigint, right: number | bigint = 1): number | bigint {
  // Counts are nonnegative: a safe sum also proves both operands were represented exactly.
  const sum = Number(left) + Number(right);

  if (Number.isSafeInteger(sum)) return sum;

  return addCount(BigInt(left), BigInt(right));
}

/** Fixed time boundaries in milliseconds; bins 0/129 are underflow/overflow. */
export class Histogram {
  readonly indices: number[] = [];
  readonly #counts: (number | bigint)[] = [];
  sum = 0;
  max = 0;
  min = Infinity;
  incomplete = false;

  constructor(
    readonly sizes = false,
    readonly wide = false,
    readonly reserve?: (bytes: number) => boolean,
  ) {}

  get counts() {
    return this.#counts.map(BigInt);
  }

  record(value: number) {
    if (!Number.isFinite(value) || value < 0) return;

    const index = this.sizes
      ? Math.min(31, value <= 1 ? 0 : Math.ceil(Math.log2(value)))
      : value < 0.001
        ? 0
        : Math.min(129, 1 + Math.max(0, Math.ceil(4 * Math.log2(value * 1000))));

    this.#add(index, 1);

    this.sum = Math.min(Number.MAX_VALUE, this.sum + value);
    this.max = Math.max(this.max, value);
    this.min = Math.min(this.min, value);
  }

  merge(other: ui.DiagnosticsHistogram | Histogram) {
    const counts = other instanceof Histogram ? other.#counts : other.counts;

    for (let at = 0; at < other.indices.length; at++) {
      const index = other.indices[at]!;

      if (index < (this.sizes ? 32 : 130)) this.#add(index, counts[at] ?? 0);
    }

    if (other instanceof Histogram) this.incomplete ||= other.incomplete;

    this.sum = Math.min(Number.MAX_VALUE, this.sum + other.sum);
    this.max = Math.max(this.max, other.max);

    if (counts.some((count) => count > 0)) this.min = Math.min(this.min, other.min ?? 0);
  }

  #add(index: number, value: number | bigint) {
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
      this.#counts.splice(at, 0, 0);
    }

    const limit = this.wide ? MAX_COUNT : MAX_BUCKET;
    const count = addSampleCount(this.#counts[at]!, value);
    this.incomplete ||= count > limit || count === MAX_COUNT;
    this.#counts[at] = count > limit ? limit : count;
  }

  subtract(other: Histogram) {
    for (let i = 0; i < other.indices.length; i++) {
      const at = this.indices.indexOf(other.indices[i]!);

      if (at === -1) continue;
      const next = BigInt(this.#counts[at]!) - BigInt(other.#counts[i]!);

      if (next > 0n) this.#counts[at] = next <= MAX_COUNTER ? Number(next) : next;
      else {
        this.#counts.splice(at, 1);
        this.indices.splice(at, 1);
      }
    }

    this.sum = Math.max(0, this.sum - other.sum);
  }

  snapshot() {
    return create(ui.DiagnosticsHistogramSchema, {
      indices: this.indices.slice(),
      counts: this.counts,
      sum: this.sum,
      max: this.max,
      min: Number.isFinite(this.min) ? this.min : undefined,
    });
  }
}

/** Merge counts before selecting exact 64-bit ranks, never averaging percentiles. */
export function percentiles(histograms: readonly (ui.DiagnosticsHistogram | Histogram)[], sizes = false) {
  if (!histograms.length) return create(ui.DiagnosticsPercentilesSchema);
  // Views multiply this helper by SQL families/RPCs. Merge only present buckets,
  // rather than allocating and scanning 130 BigInt cells for every distribution.
  const single = histograms.length === 1 && histograms[0] instanceof Histogram ? histograms[0] : undefined;
  const merged = single ?? new Histogram(sizes, true);

  if (!single) for (const histogram of histograms) merged.merge(histogram);
  const counts = merged.counts;
  const samples = counts.reduce((sum, n) => addCount(sum, n), 0n);

  let overflowQuantiles = 0;

  const quantile = (q: bigint, bit: number) => {
    let rank = (q * samples + 99n) / 100n;

    if (!samples) return 0;

    for (let at = 0; at < merged.indices.length; at++) {
      const index = merged.indices[at]!;
      rank -= counts[at]!;

      if (rank <= 0n) {
        const overflow = index === (sizes ? 31 : 129);

        if (overflow) overflowQuantiles |= bit;

        const boundary = sizes
          ? 2 ** (overflow ? index - 1 : index)
          : index
            ? 0.001 * 2 ** ((Math.min(128, index) - 1) / 4)
            : 0.001;

        return Math.max(Math.min(merged.min, merged.max), Math.min(merged.max, boundary));
      }
    }

    return merged.max;
  };

  return create(ui.DiagnosticsPercentilesSchema, {
    p50: quantile(50n, 1),
    p95: quantile(95n, 2),
    p99: quantile(99n, 4),
    max: merged.max,
    sum: merged.sum,
    samples: BigInt(samples),
    overflow: merged.indices.at(-1) === (sizes ? 31 : 129),
    overflowQuantiles,
  });
}
