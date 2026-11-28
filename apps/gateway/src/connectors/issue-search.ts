import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { exactTrackerMatch, issueTrackerName, parseIssueUrl } from "@canopy/domain";
import { Code, ConnectError } from "@connectrpc/connect";
import { CompatibilityCallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { Effect } from "effect";
import { listMcpTools, withMcp } from "../bots/mcp.ts";
import type { McpConnection } from "../bots/types.ts";
import { githubName } from "../github/discovery.ts";
import { searchGitHubMentions } from "../github/issue-mentions.ts";
import type { GitHubAccounts } from "../github/service.ts";
import { Invalid } from "../store/errors.ts";
import type { IssueAccount } from "./issue-access.ts";
import { searchProviderIssues } from "./issue-providers.ts";
import { redactConnector } from "./oauth.ts";
import type { AccountRow, Credentials } from "./records.ts";
import type { ConnectorsRuntime } from "./runtime.ts";

type ConnectAccount = (accountId: string) => Promise<{ row: AccountRow; server: McpConnection; value: Credentials }>;

const githubUrlKey = (url: string) => url.toLowerCase().replace(/\/$/, "");

interface SearchContext {
  connect: ConnectAccount;
  query: string;
  includePullRequests: boolean;
  repository: string;
  limit: number;
  signal: AbortSignal;
  granted(account: IssueAccount): Promise<boolean>;
  audit(account: IssueAccount, tool: string, outcome: string): Promise<void>;
}

async function searchAccount(context: SearchContext, account: IssueAccount) {
  const { query, repository, limit, signal } = context;
  signal.throwIfAborted();
  const connection = await context.connect(account.id);

  if (String(connection.row.revision) !== account.revision || !(await context.granted(account)))
    throw new Error("Issue account changed");

  return withMcp(connection.server, signal, async (client) => {
    const tools = await listMcpTools(client, connection.server, signal);
    const allowed = new Set(tools.filter((tool) => tool.readOnly).map((tool) => tool.remoteName));

    let warning = "";

    const hits = await searchProviderIssues(
      account.provider,
      query,
      async (name, args) => {
        if (!allowed.has(name)) throw new Error("Issue search tool is unavailable");

        if (!(await context.granted(account))) throw new Error("Issue account changed");
        signal.throwIfAborted();

        const result = await client.callTool({ name, arguments: args }, undefined, { signal }).catch(async (error) => {
          await context.audit(account, name, "error");
          throw error;
        });

        await context.audit(account, name, result.isError ? "error" : "completed");
        const json = JSON.stringify(result);

        if (json.length > 1_000_000) throw new Error("Issue search response is too large");

        const safe = redactConnector(json, connection.value);

        return safe === json ? result : CompatibilityCallToolResultSchema.parse(JSON.parse(safe));
      },
      {
        repository,
        limit,
        includePullRequests: context.includePullRequests,
        onPartialFailure: (kind) => {
          warning = `Could not search GitHub ${kind} with ${account.name}. Check the connection or try again.`;
        },
      },
    );

    const issues = hits.map((issue) =>
      create(ui.IssueSearchMatchSchema, {
        ...issue,
        accountId: account.id,
        accountLabel: account.name,
        provider: account.provider,
      }),
    );

    return { issues, warning };
  });
}

function searchConnectors(accounts: readonly IssueAccount[], context: SearchContext) {
  return Effect.runPromise(
    Effect.forEach(
      accounts,
      (account) =>
        Effect.promise(async () => {
          try {
            return { account, ...(await searchAccount(context, account)) };
          } catch {
            return {
              account,
              issues: [],
              warning: `Could not search ${issueTrackerName(account.provider)} · ${account.name}. Check the connection or try again.`,
            };
          }
        }),
      { concurrency: 4 },
    ),
  );
}

export async function searchIssues(
  runtime: Pick<ConnectorsRuntime, "run">,
  connect: ConnectAccount,
  github: GitHubAccounts,
  request: ui.SearchIssuesRequest,
  callerSignal: AbortSignal,
) {
  const owner = github.owner;
  const query = request.query.trim();

  if (query.length > 256 && !parseIssueUrl(query)) throw new Invalid("Use a search of 256 characters or fewer");
  const read = () => runtime.run((store) => store.issueSources(owner, request.scope));
  const { accounts, placement } = await read();
  const repository = githubName(placement.git_origin);
  const limit = Math.min(request.limit || 20, 50);
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(25_000)]);
  const response = create(ui.SearchIssuesResponseSchema);

  if (!repository && !accounts.length) return response;

  const [native, pages] = await Promise.all([
    searchGitHubMentions(github, repository, query, request.includePullRequests, limit, signal),
    searchConnectors(accounts, {
      connect,
      query,
      includePullRequests: request.includePullRequests,
      limit,
      signal,
      repository,
      audit: async (account, tool, outcome) => {
        await runtime.run((store) =>
          store.audit(
            {
              userId: owner,
              workerId: placement.worker_id,
              accountId: account.id,
              ...(request.scope?.threadId && { threadId: request.scope.threadId }),
            },
            tool,
            outcome,
          ),
        );
      },
      granted: async (account) =>
        (await read()).accounts.some((a) => a.id === account.id && a.revision === account.revision),
    }),
  ]);

  if (callerSignal.aborted) throw new ConnectError("Issue search cancelled", Code.Canceled);
  // Access or the workspace origin can change while another source is still sending its response.
  const current = await read();
  const matches: { rank: number; issue: ui.IssueSearchMatch }[] = [];
  const nativeUrls = new Set<string>();

  if (repository === githubName(current.placement.git_origin) && (!native.isCurrent || (await native.isCurrent()))) {
    response.connectedSources = native.connectedSources;
    response.warnings.push(...native.warnings);

    native.issues.forEach((issue, rank) => {
      nativeUrls.add(githubUrlKey(issue.url));
      matches.push({ issue, rank: exactTrackerMatch(issue, query) ? -1 : rank });
    });
  }

  for (const { account, issues, warning } of pages) {
    if (!current.accounts.some((a) => a.id === account.id && a.revision === account.revision)) continue;
    response.connectedSources++;

    if (warning) response.warnings.push(warning);

    issues.forEach((issue, rank) => {
      if (issue.provider === "github" && nativeUrls.has(githubUrlKey(issue.url))) return;
      matches.push({ issue, rank: exactTrackerMatch(issue, query) ? -1 : rank });
    });
  }

  response.issues = matches
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit)
    .map((m) => m.issue);

  return response;
}
