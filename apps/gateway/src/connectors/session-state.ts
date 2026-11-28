import { create } from "@bufbuild/protobuf";
import { type ConnectorTool, ui } from "@canopy/contracts";
import { ConnectorSessionCatalog, connectorSessionCatalog } from "@canopy/domain/connector-session";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { connectorLabel } from "./catalog.ts";

/**
 * Durable worker reports are read only after the caller has authorized this thread. A session's first
 * catalog arrives as a silent `connectors_baseline` and counts as applied.
 */
export function connectorSessionState(
  sql: SqlClient.SqlClient,
  threadId: string,
  accounts: ui.ThreadConnector[],
  tools: ConnectorTool[],
) {
  return Effect.gen(function* () {
    const reports = yield* sql<{ code: string; catalog: string; seq: string }>`
      SELECT DISTINCT ON (code) code, catalog, seq FROM (
        SELECT CASE payload->'notice'->>'code' WHEN 'connectors_failed' THEN 'connectors_failed'
            ELSE 'connectors_applied' END AS code,
          payload->'notice'->>'dataJson' AS catalog, seq::text AS seq, seq AS position
        FROM thread_events WHERE thread_id=${threadId}::uuid AND kind='notice'
          AND payload->'notice'->>'code' IN ('connectors_baseline','connectors_applied','connectors_failed')
      ) reports
      ORDER BY code, position DESC`;

    const applied = reports.find((r) => r.code === "connectors_applied");
    const failed = reports.find((r) => r.code === "connectors_failed");

    const decode = (catalog: string) =>
      Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(ConnectorSessionCatalog))(catalog), () => []);

    const before = applied ? decode(applied.catalog) : [];
    const hasFailure = !!failed && BigInt(failed.seq) > BigInt(applied?.seq ?? 0);
    const rejected = hasFailure ? decode(failed.catalog) : [];

    const sameCatalog = (a: ConnectorSessionCatalog, b: ConnectorSessionCatalog) =>
      JSON.stringify(a) === JSON.stringify(b);

    const desired = connectorSessionCatalog(tools.slice(0, 256));

    // Deleted accounts remain visible only until the session confirms their removal.
    for (const account of before)
      if (account.connectorType !== "github_repository" && !accounts.some((a) => a.accountId === account.accountId))
        accounts.push(
          create(ui.ThreadConnectorSchema, {
            accountId: account.accountId,
            accountLabel: account.accountName,
            connectorName: connectorLabel(account.connectorType),
            status: "disconnected",
          }),
        );

    for (const account of accounts) {
      const attached = before.find((a) => a.accountId === account.accountId);
      const next = desired.find((a) => a.accountId === account.accountId);

      const failure =
        hasFailure &&
        sameCatalog(rejected, desired) &&
        (!!attached || !!next) &&
        (attached?.signature !== next?.signature || attached?.accountName !== next?.accountName);

      account.sessionAttached = !!attached;
      account.sessionState = failure
        ? "failed"
        : !account.granted || account.status !== "connected"
          ? attached
            ? "pending_removal"
            : "unavailable"
          : next && attached?.signature === next.signature && attached.accountName === next.accountName
            ? "available"
            : !applied
              ? ""
              : next
                ? "pending"
                : "unavailable";

      if (account.sessionState === "failed")
        account.sessionDetail = "The agent could not load connector tools. Send a new message to retry.";
    }

    return accounts;
  });
}
