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
    await Bun.write(`${this.directory}/${this.member}-${this.#phase}.profile.json`, JSON.stringify(value));
  }

  async heap(point = "end") {
    if (!this.directory) throw new Error("Heap evidence requires an explicit output directory");

    if (!/^[a-z_]+$/.test(point)) throw new Error("Invalid heap checkpoint");
    const path = `${this.directory}/${this.member}-${this.#phase}-${point}`;
    const before = { at: Date.now(), memory: process.memoryUsage(), stats: heapStats(), retained: this.retained() };
    await this.#snapshot(`${path}-before.heapsnapshot.json`);
    Bun.gc(true);
    await Bun.sleep(0);
    Bun.gc(true);
    const after = { at: Date.now(), memory: process.memoryUsage(), stats: heapStats(), retained: this.retained() };
    await Bun.write(`${path}.heap.json`, JSON.stringify({ before, after }));
    await this.#snapshot(`${path}-after.heapsnapshot.json`);
  }

  async #snapshot(path: string) {
    await Bun.write(path, JSON.stringify(Bun.generateHeapSnapshot()));
  }
}
