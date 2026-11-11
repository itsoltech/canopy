import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";

/** A single visible page stays mounted. Returning to a loaded page preserves its position. */
export class PullRequestPages<T extends { page?: github.PullRequestPageInfo }> {
  pages = $state.raw<T[]>([]);
  index = $state(0);
  busy = $state(false);
  error = $state("");
  #request = 0;
  constructor(readonly load: (cursor: string, refresh: boolean) => Promise<T>) {}
  get current() {
    return this.pages[this.index];
  }
  invalidate() {
    this.#request++;
    this.busy = false;
    this.pages = [];
    this.index = 0;

    return this.read(false, true);
  }
  async read(next = false, refresh = false) {
    if (this.busy) return;

    const cursor = next
      ? (this.current?.page?.nextCursor ?? "")
      : this.index
        ? (this.pages[this.index - 1]?.page?.nextCursor ?? "")
        : "";

    const run = ++this.#request;
    this.busy = true;
    this.error = "";

    try {
      const value = await this.load(cursor, refresh);

      if (run !== this.#request) return;

      if (next) {
        this.pages = [...this.pages.slice(0, this.index + 1), value];
        this.index++;
      } else this.pages = [...this.pages.slice(0, this.index), value, ...this.pages.slice(this.index + 1)];
    } catch {
      this.error = "Could not load this page. Refresh the pull request, then retry.";
    } finally {
      if (run === this.#request) this.busy = false;
    }
  }
  request(id: string, cursor: string) {
    return create(github.PullRequestPageRequestSchema, { pullRequestId: id, cursor });
  }
}
