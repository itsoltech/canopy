import type { ui } from "@canopy/contracts";

/** A reset acknowledgement fences every old page, including responses already in flight. */
export class DiagnosticsEpochs {
  readonly #values = new Map<string, { epoch: string; at: bigint }>();

  clear() {
    this.#values.clear();
  }

  accept(value: ui.ComputerDiagnostics) {
    const previous = this.#values.get(value.computerId);

    if (previous && value.epoch !== previous.epoch && value.epochStartedAtMs <= previous.at) return false;

    if (value.epoch) this.reset(value.computerId, value.epoch, value.epochStartedAtMs);

    return true;
  }

  reset(computer: string, epoch: string, at: bigint) {
    if (!this.#values.has(computer) && this.#values.size >= 32) this.#values.delete(this.#values.keys().next().value!);
    this.#values.set(computer, { epoch, at });
  }
}
