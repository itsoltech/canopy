import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { ConnectorToolSchema, ui } from "@canopy/contracts";
import { ConnectorSessionCatalog, connectorSessionCatalog } from "@canopy/domain/connector-session";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { connectorType } from "./catalog.ts";

/** Durable worker reports are read only after the caller has authorized this thread. */
export function connectorSessionState(
  sql: SqlClient.SqlClient,
  threadId: string,
  accounts: ui.ThreadConnector[],
  tools: JsonValue[][],
) {
  return Effect.gen(function* () {
    const reports = yield* sql<{ code: string; catalog: string; seq: string }>`
      SELECT DISTINCT ON (payload->'notice'->>'code') payload->'notice'->>'code' AS code,
        payload->'notice'->>'dataJson' AS catalog, seq::text
      FROM thread_events WHERE thread_id=${threadId}::uuid AND kind='notice'
        AND payload->'notice'->>'code' IN ('connectors_applied','connectors_failed')
      ORDER BY payload->'notice'->>'code',thread_events.seq DESC`;

    const applied = reports.find((r) => r.code === "connectors_applied");
    const failed = reports.find((r) => r.code === "connectors_failed");

    const decode = (catalog: string) =>
      Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(ConnectorSessionCatalog))(catalog), () => []);

    const before = applied ? decode(applied.catalog) : [];
    const hasFailure = !!failed && BigInt(failed.seq) > BigInt(applied?.seq ?? 0);
    const rejected = hasFailure ? decode(failed.catalog) : [];

    const sameCatalog = (a: ConnectorSessionCatalog, b: ConnectorSessionCatalog) =>
      JSON.stringify(a) === JSON.stringify(b);

    const desired = connectorSessionCatalog(
      accounts
        .flatMap((account, i) =>
          account.granted && account.status === "connected"
            ? (tools[i] ?? []).map((tool) => ({
                ...fromJson(ConnectorToolSchema, tool),
                accountName: account.accountLabel,
              }))
            : [],
        )
        .slice(0, 256),
    );

    // Deleted accounts remain visible only until the session confirms their removal.
    for (const account of before)
      if (!accounts.some((a) => a.accountId === account.accountId))
        accounts.push(
          create(ui.ThreadConnectorSchema, {
            accountId: account.accountId,
            accountLabel: account.accountName,
            connectorName: connectorType(account.connectorType)?.name ?? account.connectorType,
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
