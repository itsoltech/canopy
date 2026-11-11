import { heapStats, profile, type SamplingProfile } from "bun:jsc";

/** Opt-in evidence only: never enabled by the overhead launcher. */
export class DiagnosticsForensics {
  #finish: (() => void) | undefined;
  #profile: Promise<SamplingProfile> | undefined;
  #phase = "";
  readonly directory = process.env["CANOPY_BENCH_FORENSICS_DIR"];
  readonly member = process.env["CANOPY_BENCH_DIAGNOSTICS"] === "1" ? "on" : "off";

  constructor(readonly retained: () => object = () => ({})) {}

  begin(phase?: string) {
    if (!this.directory || !phase) return;

    if (!/^[a-z_]+$/.test(phase)) throw new Error("Invalid forensic phase");
    this.#phase = phase;

    if (process.env["CANOPY_BENCH_FORENSIC_CHECKPOINTS"] === "1") return;
    this.#profile = profile(
      () =>
        new Promise<void>((resolve) => {
          this.#finish = resolve;
        }),
      1000,
    );
  }

  async end() {
    if (!this.directory || !this.#profile) return;
    this.#finish?.();
    const value = await this.#profile;
    this.#finish = undefined;
    this.#profile = undefined;
    await Bun.write(`${this.directory}/${this.member}-${this.#phase}.profile.json`, JSON.stringify(value), { mode: 0o600 });
  }

  async heap(point = "end") {
    if (!this.directory) throw new Error("Heap evidence requires an explicit output directory");

    if (!/^[a-z_]+$/.test(point)) throw new Error("Invalid heap checkpoint");
    const path = `${this.directory}/${this.member}-${this.#phase}-${point}`;
    const before = { at: Date.now(), memory: process.memoryUsage(), stats: heapStats(), retained: this.retained() };
    const selected = process.env["CANOPY_BENCH_FORENSIC_SNAPSHOT_POINT"];

    // A heap snapshot collects garbage. Independent runs select a single checkpoint so an
    // earlier snapshot cannot erase the allocation carryover being investigated later.
    if (selected && point !== selected) {
      await Bun.write(`${path}.counts.json`, JSON.stringify(before), { mode: 0o600 });

      return;
    }

    // Capture pre-GC counts only: generating a snapshot itself collects garbage.
    // The single snapshot below describes the explicitly collected retained heap.
    Bun.gc(true);
    await Bun.sleep(0);
    Bun.gc(true);
    const after = { at: Date.now(), memory: process.memoryUsage(), stats: heapStats(), retained: this.retained() };
    await Bun.write(`${path}.heap.json`, JSON.stringify({ before, after }), { mode: 0o600 });
    await this.#snapshot(`${path}-after.heapsnapshot.json`);
  }

  async #snapshot(path: string) {
    const snapshot =
      process.env["CANOPY_BENCH_FORENSIC_FORMAT"] === "v8"
        ? Bun.generateHeapSnapshot("v8", "arraybuffer")
        : JSON.stringify(Bun.generateHeapSnapshot());
    await Bun.write(path, snapshot, { mode: 0o600 });
  }
}
