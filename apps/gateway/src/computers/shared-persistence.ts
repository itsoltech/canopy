import { type Message } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { parseSharedKey } from "@canopy/domain/computers";

import { methodNamed } from "./remote.ts";

import { sharedState, type Row } from "./shared-context.ts";
import type { SharedConfig } from "./shared.ts";

/** One change of sharing state at a time; never held across a call to another computer. */
export function sharedExclusive<A>(hostContext: SharedConfig, run: () => Promise<A>): Promise<A> {
  const next = hostContext[sharedState].queue.then(run, run);
  hostContext[sharedState].queue = next.catch(() => {});

  return next;
}

export async function sharedSave(hostContext: SharedConfig, row: Row) {
  await hostContext.store.query(
    `INSERT INTO computer_shared_items(owner_user_id,item_key,shared,clock,digest,changed_by,changed_at,tokens,note)
      VALUES($1::uuid,$2,$3,$4::jsonb,$5,$6,$7,$8::jsonb,$9) ON CONFLICT(owner_user_id,item_key) DO UPDATE SET shared=excluded.shared,clock=excluded.clock,
      digest=excluded.digest,changed_by=excluded.changed_by,changed_at=excluded.changed_at,tokens=excluded.tokens,note=excluded.note`,
    [
      hostContext.store.owner,
      row.item_key,
      row.shared,
      JSON.stringify(row.clock),
      row.digest,
      row.changed_by,
      row.changed_at,
      JSON.stringify(row.tokens),
      row.note,
    ],
  );
  hostContext[sharedState].rows.set(row.item_key, row);
  const key = parseSharedKey(row.item_key);

  if (key?.kind === "project") {
    if (row.shared) hostContext.projects.add(key.id);
    else hostContext.projects.delete(key.id);
  }
}

export function sharedRow(hostContext: SharedConfig, key: string): Row {
  return (
    hostContext[sharedState].rows.get(key) ?? {
      item_key: key,
      shared: false,
      clock: {},
      digest: "",
      changed_by: "",
      changed_at: new Date(),
      tokens: {},
      note: "",
    }
  );
}

export async function sharedAck(
  hostContext: SharedConfig,
  node: string,
  key: string,
  digest: string | undefined,
  shared = true,
) {
  if (digest === undefined)
    await hostContext.store.query(
      "DELETE FROM computer_shared_acks WHERE owner_user_id=$1::uuid AND node_id=$2 AND item_key=$3",
      [hostContext.store.owner, node, key],
    );
  else
    await hostContext.store.query(
      `INSERT INTO computer_shared_acks(owner_user_id,node_id,item_key,digest,shared) SELECT $1::uuid,$2,$3,$4,$5
      WHERE EXISTS(SELECT 1 FROM computer_peers WHERE owner_user_id=$1::uuid AND node_id=$2)
      ON CONFLICT(owner_user_id,node_id,item_key) DO UPDATE SET digest=excluded.digest,shared=excluded.shared`,
      [hostContext.store.owner, node, key, digest, shared],
    );
}

export async function sharedLocal<A extends Message>(
  hostContext: SharedConfig,
  name: string,
  request: Message,
): Promise<A> {
  const method = methodNamed(name)!;
  const abort = new AbortController();

  try {
    for await (const value of hostContext.host.serve(method, request, abort.signal)) {
      // SAFETY: Call sites choose A from the named method's output descriptor; host.serve supplies that method's reply.
      return value as A;
    }
  } finally {
    abort.abort();
  }

  throw new ConnectError("No answer", Code.Internal);
}

export interface SharedPersistenceMethods {
  load(): Promise<void>;
}

export const sharedPersistenceMethods: SharedPersistenceMethods = {
  async load(this: SharedConfig) {
    const rows = await this.store.query<Row>("SELECT * FROM computer_shared_items WHERE owner_user_id=$1::uuid", [
      this.store.owner,
    ]);

    this[sharedState].rows = new Map(rows.map((r) => [r.item_key, r]));
    this.projects.clear();

    for (const r of rows) {
      const key = parseSharedKey(r.item_key);

      if (r.shared && key?.kind === "project") this.projects.add(key.id);
    }
  },
};
