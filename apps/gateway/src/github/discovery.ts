import { Schema } from "effect";
import type { GitPrContext } from "@canopy/contracts";
import type { GitHubPullRequests } from "./pull-requests.ts";
import { repositoryName } from "./repository-accounts.ts";

const Repository = Schema.Struct({
  id: Schema.Number,
  full_name: Schema.String,
  parent: Schema.optional(Schema.Struct({ id: Schema.Number, full_name: Schema.String })),
});

const repo = Schema.Struct({ id: Schema.Number, full_name: Schema.String });

export const DiscoveredPull = Schema.Struct({
  number: Schema.Number,
  state: Schema.String,
  merged_at: Schema.NullOr(Schema.String),
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String, repo: Schema.NullOr(repo) }),
  base: Schema.Struct({ ref: Schema.String, repo }),
});

export type DiscoveredPull = typeof DiscoveredPull.Type;

export function githubName(identity: string) {
  const name = /^github\.com\/([^/]+\/[^/]+)$/i.exec(identity)?.[1];

  if (!name) return "";

  try {
    return repositoryName(name).toLowerCase();
  } catch {
    return "";
  }
}

/** Prefer the configured push target. An alias, multiple URLs or a complex refspec never guesses. */
export function headTarget(context: GitPrContext) {
  if (!context.branch || !context.headOid || context.ambiguous) return;

  const remote = context.pushRemote
    ? context.remotes.find((r) => r.name === context.pushRemote)
    : context.upstreamRemote
      ? context.remotes.find((r) => r.name === context.upstreamRemote)
      : context.remotes.find((r) => r.name === "origin");

  const names = [...new Set(remote?.pushRepositories.map(githubName) ?? [])];
  const ref = context.pushRef || context.upstreamRef;

  if (names.length !== 1 || !names[0] || !ref) return;

  return { name: names[0], ref };
}

export class GitHubDiscovery {
  constructor(readonly prs: GitHubPullRequests) {}

  async targets(context: GitPrContext, projectOrigin: string) {
    const head = headTarget(context);

    if (!head) return;
    const bases = new Set([githubName(projectOrigin), head.name]);

    for (const remote of context.remotes)
      if (remote.name === "upstream" || remote.name === context.upstreamRemote)
        for (const name of remote.fetchRepositories.map(githubName)) if (name) bases.add(name);
    const { run, owner } = this.prs.accounts;
    const mapped = [];

    for (const name of bases) {
      if (!name || !(await run((s) => s.repositoryAccount(owner, name))).length) continue;
      mapped.push(await this.prs.repositories.selected(name));
    }

    if (!mapped.length) return;
    const account = mapped[0]!.row;

    const identity = await this.prs.client.read(account.id, {
      key: `repository:${head.name}:identity`,
      path: `/repos/${head.name}`,
      ttl: 300_000,
      background: true,
    });

    const repository = Schema.decodeUnknownSync(Repository)(identity.payload);

    if (repository.full_name.toLowerCase() !== head.name) return;

    if (repository.parent) {
      const name = repositoryName(repository.parent.full_name).toLowerCase();

      if (
        !mapped.some((m) => m.mapping.repository_id === String(repository.parent!.id)) &&
        (await run((s) => s.repositoryAccount(owner, name))).length
      )
        mapped.push(await this.prs.repositories.selected(name));
    }

    return { head: { ...head, id: String(repository.id) }, bases: mapped };
  }

  async page(
    account: string,
    baseId: string,
    baseName: string,
    headOwner: string,
    ref: string,
    page: number,
    headOid = "",
  ) {
    const path = `/repos/${repositoryName(baseName)}/pulls`;

    const params = new URLSearchParams({
      state: "all",
      head: `${headOwner}:${ref}`,
      per_page: "100",
      page: String(page),
    });

    const result = await this.prs.client.read(account, {
      key: `discovery:${baseId}:${headOwner}:${ref}:${page}:${headOid}`,
      path: `${path}?${params}`,
      ttl: 300_000,
      background: true,
      project: async (value, headers) => {
        const items = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(DiscoveredPull) }))(
          value,
        ).items.slice(0, 100);

        const next = headers
          .get("link")
          ?.split(",")
          .find((entry) => /;\s*rel="next"/.test(entry));

        const match = next && /<([^>]+)>/.exec(next);
        let nextPage = 0;

        if (match) {
          const url = new URL(match[1]!);
          const number = Number(url.searchParams.get("page"));

          if (url.origin === "https://api.github.com" && url.pathname === path && number === page + 1)
            nextPage = number;
        }

        return Schema.decodeUnknownSync(Schema.JsonObject)({ items, nextPage });
      },
    });

    return Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(DiscoveredPull), nextPage: Schema.Number }))(
      result.payload,
    );
  }
}
