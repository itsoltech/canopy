import { fromJsonString } from "@bufbuild/protobuf";
import { GitPrContextSchema, type GitPrContext } from "@canopy/contracts";
import { Schema } from "effect";
import { GIT_PR_CONTEXT_CAPABILITY } from "@canopy/domain/release/protocol";
import type { GatewayCore } from "../core/core.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import { GitHubDiscovery, DiscoveredPull, headTarget } from "./discovery.ts";
import { pullRequestUrl } from "./repository-accounts.ts";
import { githubFailure } from "./http.ts";
import type { DetectionThread, ContextRow } from "./store-detection.ts";
import type { DetectionEvidence } from "./store-pull-requests.ts";

/** Checkout discovery and replay run independently of thread locks, turn dispatch and worker ACK. */
export class GitHubDetection {
  readonly discovery;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #contexts = new Map<string, { at: number; value: Promise<GitPrContext | undefined> }>();
  readonly #pending = new Set<Promise<void>>();
  #timer?: ReturnType<typeof setInterval>;
  #flight: Promise<void> | undefined;
  #stopped = false;
  constructor(readonly core: GatewayCore) {
    this.discovery = new GitHubDiscovery(core.github.prs);
  }

  request(id: string, fresh = true) {
    if (this.#stopped || this.#timers.has(id)) return;

    if (fresh) this.#contexts.clear();

    const timer = setTimeout(() => {
      this.#timers.delete(id);
      this.track(this.core.github.run((s) => s.detectionRequest(this.core.github.owner, id)).then(() => this.tick()));
    }, 1_000);

    timer.unref?.();
    this.#timers.set(id, timer);
  }
  start() {
    if (this.#timer || this.#stopped) return;
    this.track(this.core.github.run((s) => s.detectionSeed(this.core.github.owner)).then(() => this.tick()));
    this.#timer = setInterval(() => void this.tick().catch(() => {}), 5_000);
    this.#timer.unref?.();
  }
  async stop() {
    this.#stopped = true;
    clearInterval(this.#timer);

    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    await Promise.allSettled(this.#pending);
    await this.#flight;
    this.#contexts.clear();
  }
  private track(work: Promise<void>) {
    this.#pending.add(work);
    void work.catch(() => {}).finally(() => this.#pending.delete(work));
  }
  tick(): Promise<void> {
    if (this.#stopped) return Promise.resolve();

    if (!this.#flight)
      this.#flight = this.#tick().finally(() => {
        this.#flight = undefined;
      });

    return this.#flight;
  }
  async context(thread: DetectionThread, ancestors: string[] = [], expectedHead = "") {
    const connection = this.core.link.connections.get(thread.worker_id);

    if (!connection?.isOpen || !connection.hello.capabilities.includes(GIT_PR_CONTEXT_CAPABILITY)) return;
    const key = `${thread.worker_id}:${thread.cwd}`;
    const cached = this.#contexts.get(key);

    if (!ancestors.length && cached && cached.at + 30_000 > Date.now()) return cached.value;

    const value = coreWorkerQuery(
      this.core,
      thread.worker_id,
      {
        case: "readGitPrContext",
        value: { repoPath: thread.cwd, fresh: true, expectedHead, ancestorOids: ancestors },
      },
      5_000,
    ).then((result) => result.gitPrContext);

    if (!ancestors.length) {
      if (this.#contexts.size >= 200) this.#contexts.delete(this.#contexts.keys().next().value!);
      this.#contexts.set(key, { at: Date.now(), value });
    }

    return value;
  }
  async #tick() {
    const { run, owner } = this.core.github;
    const lease = Bun.randomUUIDv7();
    const thread = (await run((s) => s.detectionClaim(owner, lease)))[0];

    if (!thread) return;
    let seq = thread.event_seq;
    let detail = "";
    let more = false;
    const cursors = { ...Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Number))(thread.cursors) };

    try {
      const context = await this.context(thread);

      if (!context?.headOid) return;
      const saved = await run((s) => s.detectionSaveContext(owner, thread.thread_id, context));
      const targets = await this.discovery.targets(context, thread.git_origin);

      if (targets) {
        for (const { mapping, row } of targets.bases) {
          const key = `${mapping.repository_id}:${targets.head.id}:${targets.head.ref}:${context.headOid}`;

          const page = await this.discovery.page(
            row.id,
            mapping.repository_id,
            mapping.repository_name,
            targets.head.name.split("/")[0]!,
            targets.head.ref,
            Math.floor((cursors[key] || 0) / 100) + 1,
            context.headOid,
          );

          const offset = (cursors[key] || 0) % 100;
          const deadline = Date.now() + 40_000;
          let verified = 0;
          let index = offset;

          for (; index < page.items.length; index++) {
            if (verified >= 10 || Date.now() >= deadline) break;
            const pull = page.items[index]!;

            if (
              String(pull.base.repo.id) !== mapping.repository_id ||
              String(pull.head.repo?.id) !== targets.head.id ||
              pull.head.ref !== targets.head.ref ||
              (pull.state !== "open" && pull.head.sha !== context.headOid)
            )
              continue;
            verified++;
            await this.link(thread, context, saved, pull, lease, "branch");
          }

          cursors[key] =
            index < page.items.length
              ? Math.floor((cursors[key] || 0) / 100) * 100 + index
              : page.nextPage
                ? (page.nextPage - 1) * 100
                : 0;

          if (cursors[key]) detail = "More results available. Refresh to continue discovery.";
        }
      } else if (context.branch && context.remotes.length) {
        detail = "Choose a repository account or link a pull request manually to match this branch.";
      }

      const events = await run((s) => s.detectionEvents(owner, thread.thread_id, seq));
      more = events.length === 20;

      for (const event of events) {
        if (event.output_hex) {
          const output = Buffer.from(event.output_hex, "hex").toString("utf8");

          const historical = (
            await run((s) => s.detectionContext(owner, thread.thread_id, new Date(event.occurred_at)))
          )[0];

          if (historical) await this.toolOutput(thread, historical, output, lease);
          else if (output.includes("https://github.com/"))
            detail = "Could not match a pull request from tool output. Link it manually.";
        }

        seq = event.seq;
      }
    } catch (cause) {
      detail = githubFailure(cause).rawMessage;
    } finally {
      await run((s) => s.detectionFinish(owner, thread.thread_id, lease, seq, detail, cursors, thread.requested, more));
      await this.core.github.prs.publish([thread.thread_id]);
    }
  }
  async link(
    thread: DetectionThread,
    context: GitPrContext,
    saved: ContextRow,
    pull: DiscoveredPull,
    lease: string,
    kind: DetectionEvidence["kind"],
  ) {
    const { run, owner, prs } = this.core.github;

    if (!pull.head.repo || !/^[0-9a-f]{40,64}$/.test(pull.head.sha)) return;
    const head = headTarget(context);

    if (!head || pull.head.repo.full_name.toLowerCase() !== head.name) return;
    const open = pull.state === "open";

    if (pull.head.sha !== context.headOid) {
      if (!open || kind === "tool_output") return;
      const ancestry = await this.context(thread, [pull.head.sha], context.headOid);

      if (!ancestry?.ancestorOids.includes(pull.head.sha)) return;
    }

    const snapshot = await prs.load(pull.base.repo.full_name, pull.number, false, true);

    if (snapshot.stale || snapshot.headRef !== pull.head.ref || snapshot.summary?.headSha !== pull.head.sha) return;
    const ref = snapshot.summary.ref;

    if (!ref || ref.repositoryId !== String(pull.base.repo.id)) return;

    if (snapshot.headRepositoryId !== String(pull.head.repo.id)) return;
    const current = await prs.list(thread.thread_id);

    if (current.links.some((l) => l.summary?.ref?.id === ref.id)) return;
    await run((s) =>
      s.prLink(owner, thread.thread_id, ref.id, current.revision, "auto", snapshot, {
        repository: String(pull.head.repo!.id),
        ref: pull.head.ref,
        sha: pull.head.sha,
        context: saved.id,
        lease,
        kind,
      }),
    );
  }
  async toolOutput(thread: DetectionThread, saved: ContextRow, output: string, lease: string) {
    const urls = [
      ...new Set(
        Buffer.from(output)
          .subarray(0, 65_536)
          .toString("utf8")
          .match(/https:\/\/github\.com\/[^\s<>"'`]+/g) ?? [],
      ),
    ].slice(0, 8);

    if (!urls.length) return;
    const context = fromJsonString(GitPrContextSchema, JSON.stringify(saved.context));
    const targets = await this.discovery.targets(context, thread.git_origin);

    if (!targets) return;

    for (const url of urls) {
      let ref;

      try {
        ref = pullRequestUrl(url);
      } catch {
        continue;
      }

      const { row, mapping } = await this.core.github.prs.repositories.selected(ref.name);

      const result = await this.core.github.prs.client.read(row.id, {
        key: `discovery-pr:${mapping.repository_id}:${ref.number}`,
        path: `/repos/${ref.name}/pulls/${ref.number}`,
        background: true,
      });

      const pull = Schema.decodeUnknownSync(DiscoveredPull)(result.payload);

      if (
        pull.number !== ref.number ||
        String(pull.base.repo.id) !== mapping.repository_id ||
        String(pull.head.repo?.id) !== targets.head.id
      )
        continue;
      await this.link(thread, context, saved, pull, lease, "tool_output");
    }
  }
}
