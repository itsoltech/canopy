import type { GitHubPullRequests } from "./pull-requests.ts";
import { pollMergeArchivePullRequests, pollVisiblePullRequests } from "./watch.ts";

/** The maintenance sweep shares the visible stream's producer and cannot create a second schedule. */
export class GitHubBackground {
  #timer: ReturnType<typeof setInterval> | undefined;
  #flight: Promise<void> | undefined;
  constructor(
    readonly prs: GitHubPullRequests,
    readonly archive: (threadId: string) => Promise<void> = async () => {},
  ) {}
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

    if (!(await this.prs.accounts.threadsEnabled())) return;
    const { run, owner } = this.prs.accounts;
    const candidates = await run((s) => s.mergeArchivePullRequests(owner));
    await pollMergeArchivePullRequests(this.prs, new Map(candidates.map((p) => [p.id, p.refresh])));
    await pollVisiblePullRequests(this.prs);

    for (const thread of await run((s) => s.mergeArchiveThreads(owner))) await this.archive(thread.id);
  }
  async stop() {
    clearInterval(this.#timer);
    await this.#flight;
  }
}
