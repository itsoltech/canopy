import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import { GitHubAccess } from "./access.ts";
import { Installations, Repositories, type Installation, type Repository } from "./schemas.ts";
import { reconnect } from "./records.ts";
import { GitHubHttpFailure } from "./http.ts";

export class GitHubCatalogue {
  #flights = new Map<string, Promise<void>>();
  #controllers = new Map<string, AbortController>();
  #retry = new Map<string, number>();
  #stopped = false;
  constructor(readonly access: GitHubAccess) {}
  async stop() {
    this.#stopped = true;

    for (const controller of this.#controllers.values()) controller.abort();
    await Promise.allSettled(this.#flights.values());
  }
  abort(id: string) {
    this.#controllers.get(id)?.abort();
    this.#retry.delete(id);
  }
  async refresh(id: string, force = false) {
    const { run, owner, http } = this.access;
    const row = await run((s) => s.owned(owner, id));

    if (this.#stopped) throw new ConnectError("GitHub is reconnecting. Try again in a moment.", Code.Unavailable);

    if (row.status !== "connected") throw reconnect();

    if (row.auth_kind === "pat") return;

    if (!force && row.catalog_verified_at && Number(new Date(row.catalog_verified_at)) > http.now() - 900_000) return;
    const old = this.#flights.get(id);

    if (old) return old;

    if ((this.#retry.get(id) ?? 0) > http.now())
      throw new ConnectError("GitHub is temporarily unavailable. Try again later.", Code.Unavailable);
    const controller = new AbortController();
    this.#controllers.set(id, controller);
    const promise = this.#load(id, controller.signal);
    this.#flights.set(id, promise);

    try {
      await promise;
    } catch (cause) {
      this.#retry.set(id, Math.max(http.now() + 60_000, cause instanceof GitHubHttpFailure ? cause.retryAt : 0));
      throw cause;
    } finally {
      this.#flights.delete(id);
      this.#controllers.delete(id);
    }
  }
  async #load(id: string, signal: AbortSignal) {
    const catalogue: { installation: Installation; repos: Repository[] }[] = [];
    let revision: bigint | undefined;

    for (let page = 1; page <= 10; page++) {
      const result = await this.access.get(id, `/user/installations?per_page=100&page=${page}`, signal);

      if (revision && revision !== result.row.revision) throw reconnect();
      revision = result.row.revision;
      const value = Schema.decodeUnknownSync(Installations)(result.value);

      for (const installation of value.installations) {
        const repos: Repository[] = [];

        if (!installation.suspended_at)
          for (let repoPage = 1; repoPage <= 100; repoPage++) {
            const result = await this.access.get(
              id,
              `/user/installations/${installation.id}/repositories?per_page=100&page=${repoPage}`,
              signal,
            );

            if (revision !== result.row.revision) throw reconnect();
            const value = Schema.decodeUnknownSync(Repositories)(result.value);
            repos.push(...value.repositories);

            if (repoPage * 100 >= value.total_count) break;

            if (repoPage === 100)
              throw new ConnectError(
                "Too many repositories. Choose fewer repositories in the installation.",
                Code.ResourceExhausted,
              );
          }

        catalogue.push({ installation, repos });
      }

      if (page * 100 >= value.total_count) break;

      if (page === 10)
        throw new ConnectError(
          "Too many installations. Manage your GitHub installations, then retry.",
          Code.ResourceExhausted,
        );
    }

    const row = await this.access.run((s) => s.owned(this.access.owner, id));

    if (signal.aborted || row.revision !== revision || row.status !== "connected") throw reconnect();

    if (!(await this.access.run((s) => s.saveCatalogue(row, catalogue, this.access.http.now())))) throw reconnect();
  }
  async installations(request: github.GitHubCatalogueRequest) {
    await this.refresh(request.accountId, request.refresh);
    const { owner, run } = this.access;
    const rows = await run((s) => s.installations(owner, request.accountId, request.page));

    return create(github.GitHubInstallationsResponseSchema, {
      installations: rows.slice(0, 50).map((i) => ({
        installationId: i.installation_id,
        login: i.login,
        accountType: i.account_type,
        repositorySelection: i.repository_selection,
        suspended: i.suspended,
        permissions: i.permissions,
        manageUrl:
          i.account_type === "Organization"
            ? `https://github.com/organizations/${encodeURIComponent(i.login)}/settings/installations/${i.installation_id}`
            : `https://github.com/settings/installations/${i.installation_id}`,
        verifiedAt: timestampFromDate(new Date(i.verified_at)),
      })),
      nextPage: rows.length > 50 ? request.page + 1 : 0,
    });
  }
  async repositories(request: github.GitHubCatalogueRequest) {
    await this.refresh(request.accountId);

    const rows = await this.access.run((s) =>
      s.repositories(this.access.owner, request.accountId, request.installationId, request.page),
    );

    return create(github.GitHubRepositoriesResponseSchema, {
      repositories: rows.slice(0, 50).map((r) => ({
        repositoryId: r.repository_id,
        fullName: r.full_name,
        private: r.private,
        permissions: r.permissions,
      })),
      nextPage: rows.length > 50 ? request.page + 1 : 0,
    });
  }
}
