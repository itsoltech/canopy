import type { ThreadEvent } from "@canopy/contracts";
import type { WorkerConnection } from "../worker-link/connection.ts";
import type { RpcCollector } from "./collector.ts";

type Queue = { times: number[] };

/** Bounded timestamps for already-received events. No event contents or IDs are retained. */
export class IngestDiagnostics {
  readonly #queues = new Map<WorkerConnection, Queue>();
  readonly #received = new WeakMap<ThreadEvent, number>();
  #waiting = 0;
  #active = 0;
  constructor(readonly collector: RpcCollector) {}

  receive(connection: WorkerConnection, event: ThreadEvent) {
    if (!this.collector.enabled || !this.collector.gatewayEnabled) return;
    this.collector.measure(20, 1);
    let queue = this.#queues.get(connection);

    if (!queue) {
      if (this.#queues.size >= 16 || !this.collector.budget.reserve(256)) {
        this.collector.budget.dropped++;

        return;
      }

      queue = { times: [] };
      this.#queues.set(connection, queue);
      void connection.closed.then(() => {
        const old = this.#queues.get(connection);

        if (!old) return;
        this.#waiting -= old.times.length;
        this.collector.budget.used -= 256 + old.times.length * 64;
        this.#queues.delete(connection);
      });
    }

    if (this.#waiting >= 4096 || !this.collector.budget.reserve(64)) {
      this.collector.budget.dropped++;

      return;
    }

    const at = performance.now();
    queue.times.push(at);
    this.#received.set(event, at);
    this.#waiting++;
    this.collector.measure(23, this.#waiting);
  }

  start(connection: WorkerConnection, events: readonly ThreadEvent[]) {
    if (!this.collector.enabled || !this.collector.gatewayEnabled) return;
    const fallback = performance.now();
    const acknowledged = new Set<ThreadEvent>();

    const times = events.map((event) => {
      const at = this.#received.get(event);

      if (at !== undefined) {
        this.#received.delete(event);
        const queue = this.#queues.get(connection);

        if (queue?.times.length) {
          queue.times.shift();
          this.#waiting--;
          this.collector.budget.used -= 64;
        }
      }

      return at ?? fallback;
    });

    this.#active += events.length;
    this.collector.measure(39, events.length);
    this.collector.measure(24, this.#active);
    let done = false;

    return {
      ack: (acks: ReadonlyMap<string, bigint>, committed: number) => {
        this.collector.measure(21, committed);

        for (let i = 0; i < events.length; i++) {
          const event = events[i]!;

          if (!acknowledged.has(event) && (acks.get(event.threadId) ?? -1n) >= event.journalSeq) {
            this.collector.measure(22, performance.now() - times[i]!);
            acknowledged.add(event);
          }
        }
      },
      finish: () => {
        if (done) return;
        done = true;
        this.#active -= events.length;
        this.collector.measure(24, this.#active);
      },
    };
  }

  sample(weight: number) {
    const oldest = Math.min(...[...this.#queues.values()].flatMap((queue) => queue.times.slice(0, 1)));
    this.collector.measure(23, this.#waiting, false, 0, weight);
    this.collector.measure(24, this.#active, false, 0, weight);
    this.collector.measure(25, Number.isFinite(oldest) ? performance.now() - oldest : 0, false, 0, weight);
  }
}

export type IngestObservation = NonNullable<ReturnType<IngestDiagnostics["start"]>>;
