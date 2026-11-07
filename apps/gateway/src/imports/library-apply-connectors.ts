import { createHash, randomBytes } from "node:crypto";
import { create, type JsonValue } from "@bufbuild/protobuf";
import { connectors } from "@canopy/contracts";
import { Effect, Option, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import type { GatewayCore } from "../core/core.ts";
import { coreWorkerQuery } from "../core/core-mentions.ts";
import { libraryReceipt, type LibraryRow } from "./library-store.ts";
import { importTransaction } from "./locks.ts";

/**
 * MCP servers into Connectors (docs/import.md, "Serwery MCP"). The account is a custom connector with the server's
 * endpoint and transport, and no access until the owner grants it. A header value comes from the worker only for a
 * slot the owner chose: the gateway keeps the sha256 of a one-time token on the item, asks the worker with the token,
 * and accepts the value only when the token comes back and the stored hash is the one it consumes in the same step.
 * The value goes straight into the account's encrypted credentials: never into a row, a log, an error or the UI.
 */

const READ_TIMEOUT_MS = 30_000;

const Value = Schema.Struct({
  url: Schema.String,
  transport: Schema.String,
  secrets: Schema.Array(Schema.String),
  slots: Schema.Array(Schema.Struct({ name: Schema.String, kind: Schema.String, variable: Schema.String })),
});

const Target = Schema.Struct({ accountId: Schema.String, revision: Schema.String });

export type Sql = <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) => Promise<A>;

export interface Applied {
  readonly target: { readonly [key: string]: JsonValue };
  readonly detail: string;
}

const digest = (slot: string, token: string) => createHash("sha256").update(`${slot}\0${token}`).digest("hex");

type ItemRef = Pick<LibraryRow, "id" | "run_id">;

/** The item's confirmation set or cleared, with its run locked like every library write (locks.ts). */
const setConfirmation = (sql: SqlClient.SqlClient, row: ItemRef, value: string | null) =>
  importTransaction(
    sql,
    { runs: [row.run_id] },
    () => sql`UPDATE import_library_items SET confirmation = ${value} WHERE id = ${row.id}::uuid`,
  );

/** The stored confirmation of the item, taken once: read and cleared in one transaction. */
const consume = (sql: SqlClient.SqlClient, row: ItemRef) =>
  importTransaction(sql, { runs: [row.run_id] }, () =>
    Effect.gen(function* () {
      const stored = yield* sql<{ confirmation: string | null }>`
        SELECT confirmation FROM import_library_items WHERE id = ${row.id}::uuid`;

      yield* sql`UPDATE import_library_items SET confirmation = NULL WHERE id = ${row.id}::uuid`;

      return stored[0]?.confirmation ?? null;
    }),
  );

async function secretOf(core: GatewayCore, sql: Sql, row: LibraryRow, slot: string): Promise<string> {
  const token = randomBytes(32).toString("hex");
  await sql((s) => setConfirmation(s, row, digest(slot, token)));

  try {
    const result = await coreWorkerQuery(
      core,
      row.worker_id,
      { case: "readImportSecret", value: { sourceKey: row.source_key, slot, confirmation: token, digest: row.digest } },
      READ_TIMEOUT_MS,
    );

    const stored = await sql((s) => consume(s, row));

    if (!result.importSecret || result.importSecret.confirmation !== token || stored !== digest(slot, token))
      throw new Error(`The worker's answer for ${slot} did not match this import.`);

    return result.importSecret.value;
  } finally {
    await sql((s) => setConfirmation(s, row, null));
  }
}

export async function applyConnector(core: GatewayCore, sql: Sql, row: LibraryRow): Promise<void> {
  const value = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Value))(row.value));

  if (!value) throw new Error("The import of this server is not valid. Scan again.");
  const headers: Record<string, string> = {};

  for (const slot of value.secrets) headers[slot] = await secretOf(core, sql, row, slot);

  const missing = value.slots.filter((slot) => !value.secrets.includes(slot.name)).map((slot) => slot.name);

  // The account and the item's receipt (its id and revision, what Undo checks) commit together.
  await core.connectors.save(
    create(connectors.SaveConnectorAccountRequestSchema, {
      connectorType: "custom",
      name: row.label.slice(0, 80),
      url: value.url,
      transport: value.transport,
      authKind: "headers",
      headers,
    }),
    (tx, account) =>
      libraryReceipt(row, "done", {
        target: { accountId: account.id, revision: String(account.revision) },
        detail: missing.length
          ? `Added to Connectors, no access yet. Enter ${missing.join(", ")} there.`
          : "Added to Connectors, no access yet.",
      })(tx),
  );
}

/**
 * Removes the account only while it is as the import left it: the revision is checked with the account locked, in
 * the transaction that deletes it and records the item as undone.
 */
export async function undoConnector(core: GatewayCore, sql: Sql, row: LibraryRow): Promise<void> {
  const mark = (status: "undone" | "kept") => sql((s) => libraryReceipt(row, status)(s));
  const target = Option.getOrUndefined(Schema.decodeUnknownOption(Target)(row.target));

  if (!target) return mark("undone");
  const { accounts } = await core.connectors.list(create(connectors.ListConnectorsRequestSchema, {}));

  if (!accounts.some((a) => a.id === target.accountId)) return mark("undone");

  await core.connectors.remove(target.accountId, {
    expectedRevision: BigInt(target.revision),
    receipt: libraryReceipt(row, "undone"),
    changedReceipt: libraryReceipt(row, "kept"),
  });
}
