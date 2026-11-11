import { create, fromJsonString, toJson } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import type { GitHubAccounts } from "./service.ts";
import { GitHubClient } from "./client.ts";
import { GitHubRepositoryAccounts, pullRequestUrl } from "./repository-accounts.ts";
import { SUMMARY_QUERY, summarySnapshot, pullRequestCreatedAt, partialSnapshot } from "./pull-request-query.ts";
import { githubFailure } from "./http.ts";
import { uuid } from "./records.ts";

/** Local links are durable; private summaries remain bound to the selected account/access revision. */
export class GitHubPullRequests {
  readonly client;
  readonly repositories;
  constructor(
    readonly accounts: GitHubAccounts,
    readonly publish: (ids: readonly string[]) => Promise<void>,
  ) {
    this.client = new GitHubClient(accounts.access);
    this.repositories = new GitHubRepositoryAccounts(accounts, this.client, (repo) => {
      this.client.memory.clear();

      return this.changed(repo);
    });
  }
  async changed(repo?: string) {
    const { run, owner } = this.accounts;
    const ids = (await run((s) => s.prThreads(owner, repo))).map((r) => r.id);

    for (const id of ids) await run((s) => s.prProject(owner, id));
    await this.publish(ids);
  }
  async list(threadId: string) {
    if (!uuid(threadId)) throw new ConnectError("Thread not found", Code.NotFound);

    return this.accounts.run((s) => s.prList(this.accounts.owner, threadId));
  }
  async link(request: github.LinkThreadPullRequestRequest) {
    const { run, owner } = this.accounts;
    await this.list(request.threadId);
    const ref = pullRequestUrl(request.url);
    const snapshot = await this.load(ref.name, ref.number, true);
    const id = snapshot.summary?.ref?.id;

    if (!id) throw new ConnectError("Pull request not found", Code.NotFound);
    await run((s) => s.prLink(owner, request.threadId, id, request.expectedRevision, "manual", snapshot));
    await run((s) => s.audit(owner, "link", id));
    await this.publish([request.threadId]);

    return this.list(request.threadId);
  }
  async unlink(request: github.UnlinkThreadPullRequestRequest) {
    if (!uuid(request.threadId) || !uuid(request.pullRequestId))
      throw new ConnectError("Pull request not found", Code.NotFound);
    const { run, owner } = this.accounts;
    await run((s) => s.prUnlink(owner, request.threadId, request.pullRequestId, request.expectedRevision));
    await run((s) => s.audit(owner, "unlink", request.pullRequestId));
    await this.publish([request.threadId]);

    return this.list(request.threadId);
  }
  async get(id: string, force = false) {
    if (!uuid(id)) throw new ConnectError("Pull request not found", Code.NotFound);
    const pr = await this.accounts.run((s) => s.prOwned(this.accounts.owner, id));
    const snapshot = await this.load(pr.repository_name, pr.number, force);
    await this.changed(pr.repository_id);

    return snapshot;
  }
  async load(
    name: string,
    number: number,
    force = false,
    background = false,
    wait = false,
  ): Promise<github.PullRequestSnapshot> {
    const { run, owner } = this.accounts;

    try {
      const { mapping, row } = await this.repositories.selected(name);
      const key = `summary:${mapping.repository_id}:${number}`;
      const cached = await this.client.cached(row, key);

      const read = {
        background,
        key,
        path: "/graphql",
        query: SUMMARY_QUERY,
        variables: { owner: name.split("/")[0]!, name: name.split("/")[1]!, number },
        project: async (value: Schema.JsonObject) => {
          const previous = cached?.payload
            ? fromJsonString(github.PullRequestSnapshotSchema, JSON.stringify(cached.payload))
            : undefined;

          const partial = partialSnapshot(value, previous);

          if (partial)
            return Schema.decodeUnknownSync(Schema.JsonObject)(toJson(github.PullRequestSnapshotSchema, partial));

          const snapshot = summarySnapshot(
            value,
            mapping.repository_id,
            name,
            number,
            this.accounts.http.now(),
            previous,
          );

          // SAFETY: summarySnapshot always constructs a summary and its canonical reference.
          const ref = snapshot.summary!.ref!;
          const saved = (await run((s) => s.prSave(owner, ref, pullRequestCreatedAt(value))))[0]!;
          ref.id = saved.id;
          snapshot.accountId = row.id;
          snapshot.viewerLogin = row.login;
          snapshot.accessRevision = BigInt(row.revision);

          return Schema.decodeUnknownSync(Schema.JsonObject)(toJson(github.PullRequestSnapshotSchema, snapshot));
        },
      };

      if (!force && cached?.payload && (!wait || Number(new Date(cached.expires_at)) > this.accounts.http.now())) {
        await this.validate(name, row.id, BigInt(row.revision), BigInt(mapping.revision));
        const snapshot = fromJsonString(github.PullRequestSnapshotSchema, JSON.stringify(cached.payload));

        if (Number(new Date(cached.expires_at)) <= this.accounts.http.now()) {
          snapshot.stale = true;
          snapshot.detail = "The last verified summary is shown. Refresh to check for changes.";
          void this.client
            .read(row.id, read)
            .then(() => this.changed(mapping.repository_id))
            .catch(() => {});
        }

        return snapshot;
      }

      try {
        const result = await this.client.read(row.id, read, force);
        await this.validate(name, row.id, BigInt(row.revision), BigInt(mapping.revision));
        const snapshot = fromJsonString(github.PullRequestSnapshotSchema, JSON.stringify(result.payload));

        return snapshot;
      } catch (cause) {
        const error = githubFailure(cause);

        if (error.code === Code.PermissionDenied) {
          this.client.memory.clear();
          await run((s) => s.cacheInvalidate(owner, row.id));
        }

        if (cached?.payload && [Code.Unavailable, Code.ResourceExhausted].includes(error.code)) {
          await this.validate(name, row.id, BigInt(row.revision), BigInt(mapping.revision));

          return create(github.PullRequestSnapshotSchema, {
            ...fromJsonString(github.PullRequestSnapshotSchema, JSON.stringify(cached.payload)),
            stale: true,
            detail: error.rawMessage,
          });
        }

        throw cause;
      }
    } catch (cause) {
      const error = githubFailure(cause);

      if ([Code.PermissionDenied, Code.FailedPrecondition].includes(error.code)) {
        this.client.memory.clear();
        await this.changed();
      }

      throw cause;
    }
  }
  private async validate(name: string, account: string, revision: bigint, mappingRevision: bigint) {
    const { run, owner } = this.accounts;
    const current = (await run((s) => s.repositoryAccount(owner, name)))[0];
    const row = await run((s) => s.owned(owner, account));

    if (
      row.status !== "connected" ||
      BigInt(row.revision) !== revision ||
      current?.account_id !== account ||
      BigInt(current.revision) !== mappingRevision
    )
      throw new ConnectError("Repository access changed. Refresh, then reconnect if needed.", Code.FailedPrecondition);
  }
}
