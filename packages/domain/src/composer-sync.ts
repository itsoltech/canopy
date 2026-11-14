/** Coalesces typing bursts; lifecycle checkpoints flush the same pending change. */
export class ComposerSync {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #content = "";
  constructor(
    readonly publish: () => Promise<void>,
    readonly delay = 1500,
  ) {}
  update(content: string) {
    if (content === this.#content) return;
    this.#content = content;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.flush(), this.delay);
  }
  flush() {
    clearTimeout(this.#timer);
    this.#timer = undefined;

    return this.publish().catch(() => {});
  }
  cancel() {
    clearTimeout(this.#timer);
  }
}
