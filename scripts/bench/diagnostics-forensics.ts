import { heapStats, profile, type SamplingProfile } from "bun:jsc";

/** Opt-in evidence only: never enabled by the overhead launcher. */
export class DiagnosticsForensics {
  #finish: (() => void) | undefined;
  #profile: Promise<SamplingProfile> | undefined;
  #phase = "";
  readonly directory = process.env["CANOPY_BENCH_FORENSICS_DIR"];
  readonly member = process.env["CANOPY_BENCH_DIAGNOSTICS"] === "1" ? "on" : "off";

  begin(phase?: string) {
    if (!this.directory || !phase) return;

    if (!/^[a-z_]+$/.test(phase)) throw new Error("Invalid forensic phase");
    this.#phase = phase;
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

  async heap() {
    if (!this.directory) throw new Error("Heap evidence requires an explicit output directory");
    const before = { memory: process.memoryUsage(), stats: heapStats() };
    Bun.gc(true);
    await Bun.sleep(0);
    Bun.gc(true);
    const after = { memory: process.memoryUsage(), stats: heapStats() };
    await Bun.write(`${this.directory}/${this.member}-${this.#phase}.heap.json`, JSON.stringify({ before, after }));
    await Bun.write(
      `${this.directory}/${this.member}-${this.#phase}.heapsnapshot.json`,
      JSON.stringify(Bun.generateHeapSnapshot()),
    );
  }
}
