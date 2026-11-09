import { cpuUsage } from "node:process";

type Counters = {
  messages: number;
  bytes: number;
  cpuMicros: number;
  snapshots: number;
  deltas: number;
  heartbeats: number;
  textDeltas: number;
  batches: number;
};

/** Opt-in process-local counters. Labels are channel names, never ids or payloads. */
export class SyncMetrics {
  readonly #channels = new Map<string, Counters>();
  #started = performance.now();

  record(channel: string, bytes: number, cpuMicros = 0, kind = "") {
    const counters = this.#channels.get(channel) ?? {
      messages: 0,
      bytes: 0,
      cpuMicros: 0,
      snapshots: 0,
      deltas: 0,
      heartbeats: 0,
      textDeltas: 0,
      batches: 0,
    };

    counters.messages++;
    counters.bytes += bytes;
    counters.cpuMicros += cpuMicros;
    counters.snapshots += Number(kind === "snapshot");
    counters.deltas += Number(kind === "delta");
    counters.heartbeats += Number(kind === "heartbeat");
    counters.textDeltas += Number(kind === "text" || kind === "batch");
    counters.batches += Number(kind === "batch");
    this.#channels.set(channel, counters);
  }

  reset() {
    this.#channels.clear();
    this.#started = performance.now();
  }

  snapshot() {
    const seconds = (performance.now() - this.#started) / 1000;

    return {
      seconds,
      channels: Object.fromEntries(
        [...this.#channels].map(([channel, counters]) => [
          channel,
          {
            ...counters,
            messagesPerSecond: counters.messages / seconds,
            bytesPerSecond: counters.bytes / seconds,
          },
        ]),
      ),
    };
  }
}

/** No clocks, CPU sampling, serialization or output when disabled. Read explicitly by diagnostics. */
export const syncMetrics = process.env["CANOPY_SYNC_METRICS"] === "1" ? new SyncMetrics() : undefined;

export function syncCpu() {
  return cpuUsage();
}

export function syncCpuMicros(start: ReturnType<typeof cpuUsage>) {
  const elapsed = cpuUsage(start);

  return elapsed.user + elapsed.system;
}
