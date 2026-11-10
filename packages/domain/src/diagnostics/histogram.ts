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
  readonly counts: Uint32Array | BigUint64Array;
  sum = 0;
  max = 0;
  incomplete = false;

  constructor(
    readonly sizes = false,
    readonly wide = false,
  ) {
    this.counts = wide ? new BigUint64Array(sizes ? 32 : 130) : new Uint32Array(sizes ? 32 : 130);
  }

  record(value: number) {
    if (!Number.isFinite(value) || value < 0) return;

    const index = this.sizes
      ? Math.min(31, value <= 1 ? 0 : Math.ceil(Math.log2(value)))
      : value < 0.001
        ? 0
        : Math.min(129, 1 + Math.max(0, Math.ceil(4 * Math.log2(value * 1000))));

    if (this.counts instanceof BigUint64Array) {
      this.incomplete ||= this.counts[index] === MAX_COUNT;
      this.counts[index] = addCount(this.counts[index]!);
    } else {
      this.incomplete ||= this.counts[index] === MAX_BUCKET;
      this.counts[index] = Math.min(MAX_BUCKET, this.counts[index]! + 1);
    }

    this.sum = Math.min(Number.MAX_VALUE, this.sum + value);
    this.max = Math.max(this.max, value);
  }

  merge(other: ui.DiagnosticsHistogram) {
    for (let at = 0; at < other.indices.length; at++) {
      const index = other.indices[at]!;

      if (index >= this.counts.length) continue;

      if (this.counts instanceof BigUint64Array) {
        const count = this.counts[index]! + (other.counts[at] ?? 0n);
        this.incomplete ||= count > MAX_COUNT;
        this.counts[index] = count > MAX_COUNT ? MAX_COUNT : count;
      } else {
        const count = this.counts[index]! + Number(other.counts[at] ?? 0n);
        this.incomplete ||= count > MAX_BUCKET;
        this.counts[index] = Math.min(MAX_BUCKET, count);
      }
    }

    this.sum = Math.min(Number.MAX_VALUE, this.sum + other.sum);
    this.max = Math.max(this.max, other.max);
  }

  snapshot() {
    const indices: number[] = [];
    const counts: bigint[] = [];

    for (let index = 0; index < this.counts.length; index++) {
      if (!this.counts[index]) continue;
      indices.push(index);
      counts.push(BigInt(this.counts[index]!));
    }

    return create(ui.DiagnosticsHistogramSchema, { indices, counts, sum: this.sum, max: this.max });
  }
}

/** Merge counts before selecting exact 64-bit ranks, never averaging percentiles. */
export function percentiles(histograms: readonly ui.DiagnosticsHistogram[], sizes = false) {
  const counts = new BigUint64Array(sizes ? 32 : 130);
  let max = 0;
  let sum = 0;

  for (const histogram of histograms) {
    max = Math.max(max, histogram.max);
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

        return sizes
          ? 2 ** (overflow ? index - 1 : index)
          : index
            ? 0.001 * 2 ** ((Math.min(128, index) - 1) / 4)
            : 0.001;
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
