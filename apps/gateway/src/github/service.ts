import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Cause, Effect, Exit, Schema } from "effect";
import type { CoreRuntime } from "../core/core.ts";
import { GatewayStore } from "../store/store.ts";
import { GitHubHttp, type GitHubOptions } from "./http.ts";
import { GitHubAccess, type RunGitHub } from "./access.ts";
import { GitHubDeviceFlow } from "./device.ts";
import { GitHubCatalogue } from "./catalogue.ts";
import { accountView, reconnect } from "./records.ts";
import { User } from "./schemas.ts";
import { GitHubPat } from "./pat.ts";
import { GitHubPullRequests } from "./pull-requests.ts";

/** Product GitHub access. No worker, agent tool or shared-config adapter receives this service. */
export class GitHubAccounts {
  readonly run: RunGitHub;
  readonly http: GitHubHttp;
  readonly access: GitHubAccess;
  readonly device: GitHubDeviceFlow;
  readonly catalogue: GitHubCatalogue;
  readonly pat: GitHubPat;
  readonly prs: GitHubPullRequests;
  constructor(
    readonly runtime: CoreRuntime,
    readonly owner: string,
    options: GitHubOptions = {},
    publish: (ids: readonly string[]) => Promise<void> = async () => {},
  ) {
    this.run = async (use) => {
      const result = await runtime.runPromise(Effect.exit(GatewayStore.use((s) => use(s.github))));

      if (Exit.isFailure(result)) throw Cause.squash(result.cause);

      return result.value;
    };

    this.http = new GitHubHttp(options);
    this.pat = new GitHubPat(runtime, owner);
    this.access = new GitHubAccess(this.run, this.http, owner, async (row) => {
      try {
        // SAFETY: the database requires a connector reference for every PAT account reaching this callback.
        const value = await this.pat.read(row.connector_account_id!);

        if (value.revision !== row.connector_revision) throw reconnect();

        return value.token;
      } catch {
        await this.run((s) => s.clearRevision(row));
        throw reconnect();
      }
    });
    this.prs = new GitHubPullRequests(this, publish);
    this.catalogue = new GitHubCatalogue(this.access, this.prs.client);
    this.device = new GitHubDeviceFlow(this.run, this.http, owner, (id) => this.catalogue.refresh(id));
  }
  async list() {
    await this.pat.invalidate();
    const [rows, pats] = await Promise.all([this.run((s) => s.list(this.owner)), this.pat.candidates()]);

    return create(github.GitHubAccountsResponseSchema, {
      configured: this.http.config.configured,
      installUrl: this.http.config.configured
        ? `https://github.com/apps/${this.http.config.slug}/installations/new`
        : "",
      accounts: rows.map(accountView),
      patCandidates: pats.map((p) => ({ connectorAccountId: p.id, name: p.name })),
    });
  }
  async stop() {
    await this.prs.client.stop();
    await this.device.stop();
    await this.catalogue.stop();
  }
  async disconnect(id: string) {
    this.prs.client.abort(id);
    const account = await this.run((s) => s.clear(this.owner, id, "disconnected"));
    this.catalogue.abort(id);
    await this.prs.changed();

    return create(github.GitHubAccountResponseSchema, { account });
  }
  async usePat(id: string) {
    const value = await this.pat.read(id);
    const user = Schema.decodeUnknownSync(User)(await this.http.get("/user", value.token));
    const row = await this.pat.save(id, value.revision, String(user.id), user.login);

    return create(github.GitHubAccountResponseSchema, { account: accountView(row) });
  }
}
