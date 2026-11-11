import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core.ts";
import { decodeRollup, encodeRollup, MAX_PAYLOAD, replaceProcesses, mergeWatermarks } from "./rollup.ts";
import { downsampleWrite, type RollupRow } from "./downsample.ts";
import { queryFamily, queryRpc } from "./query-context.ts";

export type StoredMinute = { at: number; processes: ui.DiagnosticsProcess[] };

export class DiagnosticsStore {
  constructor(
    readonly runtime: CoreRuntime,
    readonly owner: string,
    readonly computer: string,
  ) {}

  query<A extends object>(text: string, params: readonly (string | number | Uint8Array | Date | boolean)[] = []) {
    return this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(text, params).pipe(queryFamily("diagnostics.history"));
      }).pipe(queryRpc),
    );
  }

  async state() {
    const rows = await this.query<{ payload: Uint8Array }>(
      "SELECT payload FROM diagnostics_state WHERE owner_user_id=$1::uuid AND computer_id=$2",
      [this.owner, this.computer],
    );

    if (!rows[0]) return;

    const state = fromBinary(ui.DiagnosticsStateSchema, rows[0].payload);

    const peers = await this.query<{ computer_id: string; payload: Uint8Array; invalidated_at: Date | null }>(
      "SELECT computer_id,payload,invalidated_at FROM diagnostics_peer_cache WHERE owner_user_id=$1::uuid ORDER BY coalesce(invalidated_at,received_at) DESC LIMIT 32",
      [this.owner],
    );

    state.peerOverviews = peers.map((peer) =>
      peer.invalidated_at
        ? create(ui.ComputerDiagnosticsSchema, { computerId: peer.computer_id, status: "not_permitted" })
        : fromBinary(ui.ComputerDiagnosticsSchema, peer.payload),
    );

    return state;
  }

  async *history(since: number, until = Date.now()) {
    let after = since - 1;

    while (true) {
      const rows = await this.query<{ bucket_start: Date; payload: Uint8Array }>(
        `SELECT bucket_start,payload FROM diagnostics_rollups WHERE owner_user_id=$1::uuid AND computer_id=$2
         AND resolution=60 AND bucket_start>to_timestamp($3/1000.0) AND bucket_start<=to_timestamp($4/1000.0)
         ORDER BY bucket_start LIMIT 8`,
        [this.owner, this.computer, after, until],
      );

      for (const row of rows) {
        after = new Date(row.bucket_start).getTime();
        yield { at: after, rollup: decodeRollup(row.payload) };
      }

      if (rows.length < 8) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  /** State, dedupe watermarks and all queued minutes commit in one statement under the home lock. */
  write(minutes: StoredMinute[], state: ui.DiagnosticsState) {
    const { owner, computer } = this;

    return this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SET LOCAL lock_timeout='100ms'`;
            yield* sql`SET LOCAL statement_timeout='1000ms'`;

            const locked = yield* sql<{ payload: Uint8Array }>`SELECT payload FROM diagnostics_state
          WHERE owner_user_id=${owner}::uuid AND computer_id=${computer} FOR UPDATE`;

            const previous = locked[0] ? fromBinary(ui.DiagnosticsStateSchema, locked[0].payload) : undefined;
            const payloads: Uint8Array[] = [];
            let additions = 0;

            for (const minute of minutes) {
              const existing = yield* sql<{ payload: Uint8Array }>`SELECT payload FROM diagnostics_rollups
            WHERE owner_user_id=${owner}::uuid AND computer_id=${computer} AND resolution=60
              AND bucket_start=${new Date(minute.at)}`;

              payloads.push(
                encodeRollup(
                  replaceProcesses(existing[0] ? decodeRollup(existing[0].payload).processes : [], minute.processes),
                ),
              );

              if (!existing.length) additions++;
            }

            const next = create(ui.DiagnosticsStateSchema, {
              ...state,
              persistedThroughMs:
                previous && previous.persistedThroughMs > state.persistedThroughMs
                  ? previous.persistedThroughMs
                  : state.persistedThroughMs,
              watermarks: mergeWatermarks(previous?.watermarks ?? [], state.watermarks),
            });

            const bytes = toBinary(
              ui.DiagnosticsStateSchema,
              create(ui.DiagnosticsStateSchema, { ...next, peerOverviews: [] }),
            );

            const peers = state.peerOverviews
              .slice(0, 32)
              .filter((peer) => toBinary(ui.ComputerDiagnosticsSchema, peer).length <= 16384);

            if (bytes.length > MAX_PAYLOAD) throw new Error("Diagnostics state budget exceeded");

            const quota = yield* sql<{ count: string }>`SELECT count(*)::text AS count FROM diagnostics_rollups
          WHERE owner_user_id=${owner}::uuid AND computer_id=${computer} AND resolution=60`;

            if (Number(quota[0]?.count ?? 0) + additions > 180) throw new Error("Diagnostics retention quota reached");

            const rows: RollupRow[] = minutes.map((minute, index) => ({
              owner_user_id: owner,
              computer_id: computer,
              resolution: 60,
              bucket_start: new Date(minute.at),
              payload: payloads[index]!,
              compacted: false,
            }));

            const hours = yield* downsampleWrite(sql, rows, Date.now());
            rows.push(...hours);

            const [first, ...rest] = rows;

            if (!first) return;
            yield* sql`WITH saved AS (
          INSERT INTO diagnostics_rollups ${sql.insert([first, ...rest])}
          ON CONFLICT (owner_user_id,computer_id,resolution,bucket_start) DO UPDATE
          SET payload=EXCLUDED.payload,compacted=EXCLUDED.compacted RETURNING bucket_start
        ), compacted AS (
          UPDATE diagnostics_rollups SET compacted=true
          WHERE owner_user_id=${owner}::uuid AND computer_id=${computer} AND resolution=60 AND NOT compacted
            AND date_trunc('hour',bucket_start)=ANY(${hours.map((row) => row.bucket_start)}::timestamptz[])
            AND NOT (bucket_start=ANY(${minutes.map((minute) => new Date(minute.at))}::timestamptz[]))
        ), peers_saved AS (
          INSERT INTO diagnostics_peer_cache(owner_user_id,computer_id,payload,received_at)
          SELECT ${owner}::uuid,p.node,decode(p.bytes,'hex'),to_timestamp(p.received::double precision/1000.0)
          FROM unnest(${peers.map((peer) => peer.computerId)}::text[],
            ${peers.map((peer) => Buffer.from(toBinary(ui.ComputerDiagnosticsSchema, peer)).toString("hex"))}::text[],
            ${peers.map((peer) => peer.receivedAtMs.toString())}::text[]) p(node,bytes,received)
          JOIN computer_peers c ON c.owner_user_id=${owner}::uuid AND c.node_id=p.node
          WHERE p.node IN (
            SELECT candidate.node FROM unnest(${peers.map((peer) => peer.computerId)}::text[]) candidate(node)
            LEFT JOIN diagnostics_peer_cache cached ON cached.owner_user_id=${owner}::uuid AND cached.computer_id=candidate.node
            ORDER BY (cached.computer_id IS NOT NULL AND cached.invalidated_at IS NULL) DESC,candidate.node
            LIMIT greatest(0,32-(SELECT count(*) FROM diagnostics_peer_cache WHERE owner_user_id=${owner}::uuid AND invalidated_at IS NULL)
              +(SELECT count(*) FROM diagnostics_peer_cache WHERE owner_user_id=${owner}::uuid AND invalidated_at IS NULL
                AND computer_id=ANY(${peers.map((peer) => peer.computerId)}::text[]))))
          ON CONFLICT(owner_user_id,computer_id) DO UPDATE SET payload=EXCLUDED.payload,received_at=EXCLUDED.received_at,invalidated_at=NULL
          WHERE diagnostics_peer_cache.received_at<EXCLUDED.received_at
            AND (diagnostics_peer_cache.invalidated_at IS NULL OR diagnostics_peer_cache.invalidated_at<EXCLUDED.received_at)
        ) INSERT INTO diagnostics_state(owner_user_id,computer_id,payload,persisted_through)
          SELECT ${owner}::uuid,${computer},${bytes},to_timestamp(${Number(next.persistedThroughMs)}/1000.0)
          WHERE EXISTS(SELECT 1 FROM saved)
          ON CONFLICT(owner_user_id,computer_id) DO UPDATE SET payload=EXCLUDED.payload,persisted_through=EXCLUDED.persisted_through`;
          }),
        );
      }).pipe(queryFamily("diagnostics.write")),
    );
  }

  async initialize(state: ui.DiagnosticsState) {
    await this.query(
      "INSERT INTO diagnostics_state(owner_user_id,computer_id,payload) VALUES($1::uuid,$2,$3) ON CONFLICT DO NOTHING",
      [
        this.owner,
        this.computer,
        toBinary(ui.DiagnosticsStateSchema, create(ui.DiagnosticsStateSchema, { ...state, peerOverviews: [] })),
      ],
    );
  }
}
