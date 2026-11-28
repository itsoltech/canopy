import type { ConnectorTool } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core.ts";
import type { ConnectorsRuntime } from "./runtime.ts";
import { connectorToolCatalog } from "./slack-post-tool.ts";
import { supportsSlackDownload } from "./slack-download-tool.ts";
import { canDownloadSlackOnWorker } from "./slack-download.ts";
import { githubRepositoryTools } from "./github-repository-tools.ts";

export type ConnectorToolScope = { projectId: string; workerId: string } | { botId: string };

export async function scopedConnectorCatalog(
  service: Pick<ConnectorsRuntime, "run" | "test">,
  runtime: CoreRuntime,
  user: string,
  scope: ConnectorToolScope,
  includeSlackPost: boolean,
  includeSlackDownload: boolean,
) {
  const rows = await service.run((s) => s.list(user, scope));
  const tools: ConnectorTool[] = [];
  const repositoryRevisions = new Map<string, string>();

  const workerId = "workerId" in scope ? scope.workerId : undefined;

  const download =
    includeSlackDownload &&
    rows.some(supportsSlackDownload) &&
    (!workerId ||
      (await runtime.runPromise(SqlClient.SqlClient.use((sql) => canDownloadSlackOnWorker(sql, workerId)))));

  for (const row of rows) {
    if (row.status !== "connected" && row.status !== "error") continue;

    if (row.connector_type === "github_repository") {
      if (row.status !== "connected" || row.github_account_revision == null) continue;
      repositoryRevisions.set(row.id, `${row.revision}/${row.github_account_revision}`);
      tools.push(...githubRepositoryTools(row));
      continue;
    }

    let catalog = await service.run((s) => Effect.succeed(s.tools(row)));

    // A failed test suspends tools until a fresh listing succeeds, including cached catalogs.
    if (row.status === "error" || !catalog.length) {
      try {
        catalog = (await service.test(row.id, user)).tools;
      } catch {
        continue;
      }
    }

    const post =
      includeSlackPost && row.connector_type === "slack" && (await service.run((s) => s.slackMessagingConnected(row)));

    tools.push(...connectorToolCatalog(row, catalog, post, download));
  }

  // A bounded prompt; account catalog pages are separately capped at 256.
  return { tools: tools.slice(0, 256), repositoryRevisions };
}
