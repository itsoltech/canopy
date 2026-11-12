import type { GitHubPullRequests } from "./pull-requests.ts";
import { pollVisiblePullRequests } from "./watch.ts";

/** The maintenance sweep shares the visible stream's producer and cannot create a second schedule. */
export class GitHubBackground {
  #timer: ReturnType<typeof setInterval> | undefined;
  #flight: Promise<void> | undefined;
  constructor(readonly prs: GitHubPullRequests) {}
  start() {
    this.#timer ??= setInterval(() => void this.tick().catch(() => {}), 60_000);
    this.#timer.unref?.();
  }
  tick() {
    return (this.#flight ??= this.poll().finally(() => {
      this.#flight = undefined;
    }));
  }
  private async poll() {
    await this.prs.repositories.refresh();
    await pollVisiblePullRequests(this.prs);
  }
  async stop() {
    clearInterval(this.#timer);
    await this.#flight;
  }
}
