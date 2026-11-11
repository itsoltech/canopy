import { runProcess } from "@canopy/process-governor";

/** A fixed eight-job burst exercises four git slots and queued admissions in both pair members. */
export class DiagnosticsGovernorWorkload {
  #timer: ReturnType<typeof setInterval> | undefined;
  #pending: Promise<void> | undefined;
  started = 0;
  failed = 0;

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      if (this.#pending) return;
      this.#pending = Promise.all(
        Array.from({ length: 8 }, async () => {
          this.started++;

          try {
            const result = await runProcess(
              { argv: ["git", "--version"], timeoutMs: 2000 },
              { kind: "git", priority: "background" },
            );

            if (result.code !== 0) this.failed++;
          } catch {
            this.failed++;
          }
        }),
      )
        .then(() => {})
        .finally(() => {
          this.#pending = undefined;
        });
    }, 200);
  }

  async stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pending;
  }
}
