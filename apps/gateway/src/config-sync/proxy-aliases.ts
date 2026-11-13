import type { DescMessage, Message } from "@bufbuild/protobuf";
import { splitId } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { mapIds } from "../computers/remote-ids.ts";
import { globalIds } from "./worker-records.ts";
import { queryFamily } from "../diagnostics/query-context.ts";

/** Worker-scoped proxies and their keys belong only to the worker's home. */
export function proxyIds(sql: SqlClient.SqlClient, owner: string) {
  return Effect.gen(function* () {
    const ids = yield* globalIds(sql, owner, "proxy");

    const rows = yield* sql<{ id: string }>`SELECT id::text FROM proxies
      WHERE owner_user_id=${owner}::uuid AND NOT worker_scoped`;

    const local = new Set(rows.map((r) => r.id));
    const known = new Set(rows.flatMap((r) => [r.id, ids.toGlobal(r.id)]));

    return { ...ids, local, known };
  }).pipe(queryFamily("settings.store"));
}

export function mapProxyIds(
  desc: DescMessage,
  message: Message,
  ids: Effect.Success<ReturnType<typeof proxyIds>>,
  direction: "toLocal" | "toGlobal",
  request: boolean,
) {
  mapIds(desc, message, (value, field) => {
    if (field !== "proxy_id") return value;
    const id = splitId(value).id;
    const local = ids.toLocal(id);

    if (!ids.local.has(local)) {
      if (request) throw new ConnectError("Choose a shared proxy from Settings → Proxies.", Code.FailedPrecondition);

      return "";
    }

    return ids[direction](id);
  });
}
