import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import type { GitHubAccounts } from "./service.ts";
import type { GitHubClient } from "./client.ts";
import { accountView, uuid } from "./records.ts";
import { Repository } from "./schemas.ts";

export const repositoryName = (name: string) => {
  if (
    !/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(name) ||
    name.split("/").some((s) => s === "." || s === "..")
  )
    throw new ConnectError("Enter a GitHub repository as owner/name.", Code.InvalidArgument);

  return name;
};

export function pullRequestUrl(value: string) {
  const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]{0,9})$/.exec(value);

  if (!match || Number(match[2]) > 2_147_483_647)
    throw new ConnectError("Enter a GitHub pull request URL.", Code.InvalidArgument);

  return { name: repositoryName(match[1]!), number: Number(match[2]) };
}

export class GitHubRepositoryAccounts {
  constructor(
    readonly accounts: GitHubAccounts,
    readonly client: GitHubClient,
    readonly changed: (repo?: string) => Promise<void>,
  ) {}
  async get(name: string) {
    repositoryName(name);
    const { run, owner } = this.accounts;
    await this.accounts.pat.invalidate();

    const [rows, candidates] = await Promise.all([
      run((s) => s.repositoryAccount(owner, name)),
      run((s) => s.repositoryCandidates(owner, name)),
    ]);

    return create(github.GitHubRepositoryAccountResponseSchema, {
      repositoryId: rows[0]?.repository_id ?? "",
      repositoryName: name,
      accountId: rows[0]?.account_id ?? "",
      revision: BigInt(rows[0]?.revision ?? 0),
      candidates: candidates.map(accountView),
    });
  }
  async set(request: github.SetGitHubRepositoryAccountRequest) {
    const { run, owner } = this.accounts;
    const name = repositoryName(request.repositoryName);

    if (!uuid(request.accountId)) throw new ConnectError("GitHub account not found", Code.NotFound);
    await this.accounts.catalogue.refresh(request.accountId);
    const row = (await this.accounts.access.token(request.accountId)).row;

    const result = await this.client.read(
      row.id,
      { key: `repository:${name.toLowerCase()}:identity`, path: `/repos/${name}`, ttl: 60_000 },
      true,
    );

    const repo = Schema.decodeUnknownSync(Repository)(result.payload);

    if (row.auth_kind === "device" && !(await run((s) => s.repositoryInstalled(owner, row.id, String(repo.id)))).length)
      throw new ConnectError(
        "This repository is not available to this account. Manage its GitHub installation.",
        Code.PermissionDenied,
      );

    if (row.auth_kind === "pat" && !repo.permissions?.["pull"])
      throw new ConnectError(
        "This personal access token cannot read this repository. Choose another account.",
        Code.PermissionDenied,
      );
    await run((s) =>
      s.repositoryChoose(row, String(repo.id), repositoryName(repo.full_name), request.expectedRevision),
    );
    await run((s) => s.audit(owner, "repository_account", row.id));
    await this.changed(String(repo.id));

    return this.get(repo.full_name);
  }
  async selected(name: string) {
    const { run, owner } = this.accounts;
    const mapping = (await run((s) => s.repositoryAccount(owner, name)))[0];

    if (!mapping) throw new ConnectError("Choose an account for this repository.", Code.FailedPrecondition);
    await this.accounts.catalogue.refresh(mapping.account_id);
    const { row } = await this.accounts.access.token(mapping.account_id);

    if (
      row.auth_kind === "device" &&
      !(await run((s) => s.repositoryInstalled(owner, row.id, mapping.repository_id))).length
    ) {
      await run((s) => s.cacheInvalidate(owner, row.id));
      throw new ConnectError(
        "This repository is not available to this account. Manage its GitHub installation.",
        Code.PermissionDenied,
      );
    }

    return { mapping, row };
  }
}
