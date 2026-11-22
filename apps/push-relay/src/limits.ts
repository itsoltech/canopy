interface Policy {
  requestsPerSecond: number;
  burst: number;
  concurrent: number;
}

interface Bucket {
  inFlight: number;
  available: number;
  updatedAt: number;
}

function bucket(policy: Policy, now: number): Bucket {
  return { inFlight: 0, available: policy.burst, updatedAt: now };
}

function available(state: Bucket, policy: Policy, now: number) {
  return Math.min(policy.burst, state.available + ((now - state.updatedAt) * policy.requestsPerSecond) / 1000);
}

function spend(state: Bucket, policy: Policy, now: number) {
  state.available = available(state, policy, now) - 1;
  state.updatedAt = now;
  state.inFlight++;
}

export type Admission = { status: 429 | 503 } | { release(): void };

export class Limits {
  readonly #keys = new Map<string, Bucket>();
  readonly #global: Bucket;

  constructor(
    private readonly perKey: Policy,
    private readonly global: Policy,
    private readonly maxKeys: number,
  ) {
    this.#global = bucket(global, performance.now());
  }

  admit(key: string): Admission {
    const now = performance.now();
    const existing = this.#keys.get(key);

    if (existing && (existing.inFlight >= this.perKey.concurrent || available(existing, this.perKey, now) < 1))
      return { status: 429 };

    if (this.#global.inFlight >= this.global.concurrent) return { status: 503 };

    if (available(this.#global, this.global, now) < 1) return { status: 429 };

    if (!existing && this.#keys.size >= this.maxKeys) this.#reclaim(now);

    if (!existing && this.#keys.size >= this.maxKeys) return { status: 429 };

    const state = existing ?? bucket(this.perKey, now);

    spend(state, this.perKey, now);
    spend(this.#global, this.global, now);
    this.#keys.delete(key);
    this.#keys.set(key, state);

    return {
      release: () => {
        state.inFlight--;
        this.#global.inFlight--;
      },
    };
  }

  #reclaim(now: number) {
    // The map is ordered by last admission. Only reclaim fully replenished, idle buckets.
    for (const [key, state] of this.#keys) {
      if (((now - state.updatedAt) * this.perKey.requestsPerSecond) / 1000 < this.perKey.burst) break;

      if (state.inFlight === 0) {
        this.#keys.delete(key);

        return;
      }
    }
  }
}
