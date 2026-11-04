import { create } from "@bufbuild/protobuf";

import { computerLink as link } from "@canopy/contracts";

import { parseSharedKey } from "@canopy/domain/computers";

import { canonicalJson } from "../store/instance-config.ts";

import { encryptSecret } from "../store/secrets.ts";

import { linkedMessage } from "./remote.ts";

import {
  bump,
  compare,
  digestOf,
  failure,
  fromWire,
  merge,
  ORDER,
  payloadObject,
  PUSH_TIMEOUT_MS,
  sharedState,
  tokensIn,
  wireClock,
  type Outcome,
  type Payload,
} from "./shared-context.ts";
import { sharedAck, sharedExclusive, sharedRow, sharedSave } from "./shared-persistence.ts";
import { sharedSecretValues, sharedWrite } from "./shared-values.ts";
import type { SharedConfig } from "./shared.ts";

export async function sharedOutgoing(
  hostContext: SharedConfig,
  node: string,
  full: boolean,
): Promise<link.SharedItem[]> {
  const acks = new Map(
    (
      await hostContext.store.query<{ item_key: string; digest: string; shared: boolean }>(
        "SELECT item_key,digest,shared FROM computer_shared_acks WHERE owner_user_id=$1::uuid AND node_id=$2",
        [hostContext.store.owner, node],
      )
    ).map((a) => [a.item_key, a]),
  );

  const items: link.SharedItem[] = [];

  const rows = [...hostContext[sharedState].rows.values()].sort(
    (a, b) => (ORDER.get(a.item_key.split(":")[0]!) ?? 9) - (ORDER.get(b.item_key.split(":")[0]!) ?? 9),
  );

  for (const row of rows) {
    const key = parseSharedKey(row.item_key);
    const ack = acks.get(row.item_key);

    if (!key) continue;

    const base = {
      key: row.item_key,
      clock: wireClock(row.clock),
      changedBy: row.changed_by,
      changedAtMs: BigInt(new Date(row.changed_at).getTime()),
      digest: row.digest,
    };

    if (!row.shared) {
      if (ack?.shared)
        items.push(
          create(link.SharedItemSchema, { ...base, shared: false, reason: row.note === "deleted" ? "deleted" : "" }),
        );
      continue;
    }

    if (!full && ack?.shared && ack.digest === row.digest) continue;
    const value = await hostContext.read(key, row.tokens);

    if (!value || digestOf(value.payload) !== row.digest) continue; // the next scan versions it first
    const secrets = ack?.digest === row.digest ? [] : await sharedSecretValues(hostContext, value.refs);
    items.push(
      create(link.SharedItemSchema, { ...base, shared: true, payload: canonicalJson(value.payload), secrets }),
    );
  }

  return items;
}

export async function sharedOne(hostContext: SharedConfig, node: string, item: link.SharedItem): Promise<Outcome> {
  const key = parseSharedKey(item.key);

  if (!key || item.payload.length > 256 * 1024 || item.secrets.length > 64)
    return { outcome: "rejected", message: "unknown item" };
  const row = sharedRow(hostContext, item.key);
  const clock = fromWire(item.clock);

  if (!item.shared) {
    if (row.shared)
      await sharedSave(hostContext, {
        ...row,
        shared: false,
        clock: merge(row.clock, clock),
        note: `${item.reason === "deleted" ? "deleted" : "unshared"}:${node}`,
      });
    await hostContext.store.query(
      "DELETE FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2" +
        (row.shared ? "" : " AND node_id=$3"),
      row.shared ? [hostContext.store.owner, item.key] : [hostContext.store.owner, item.key, node],
    );
    await sharedAck(hostContext, node, item.key, undefined);

    return { outcome: "unshared" };
  }

  // Stopped sharing here and not told yet: our unshare wins and reaches the sender next.
  if (
    !row.shared &&
    (
      await hostContext.store.query(
        "SELECT 1 FROM computer_shared_acks WHERE owner_user_id=$1::uuid AND node_id=$2 AND item_key=$3 AND shared",
        [hostContext.store.owner, node, item.key],
      )
    ).length
  )
    return { outcome: "unshared" };
  let payload: Payload;

  try {
    payload = payloadObject(JSON.parse(item.payload));
  } catch {
    return { outcome: "rejected", message: "invalid item" };
  }

  if (digestOf(payload) !== item.digest) return { outcome: "rejected", message: "invalid item" };
  const current = await hostContext.read(key, row.tokens);
  const local = current ? digestOf(current.payload) : "";
  const secrets = new Map(item.secrets.map((s) => [s.token, s.value]));

  if (local === item.digest) {
    // First share of an equal value: the sender's change is the last one known here.
    const author =
      row.shared && row.changed_by
        ? {}
        : { changed_by: item.changedBy, changed_at: new Date(Number(item.changedAtMs)) };

    await sharedSave(hostContext, {
      ...row,
      ...author,
      shared: true,
      clock: merge(row.clock, clock),
      digest: local,
      tokens: current!.tokens,
      note: "",
    });
    await hostContext.store.query(
      "DELETE FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2 AND node_id=$3",
      [hostContext.store.owner, item.key, node],
    );
    await sharedAck(hostContext, node, item.key, item.digest);

    return { outcome: "same" };
  }

  const order = row.shared ? compare(row.clock, clock) : current && !current.empty ? "concurrent" : "before";

  if (order === "after" || order === "equal") return { outcome: "newer" };

  if (order === "concurrent") {
    // Keep the other version (and its secrets, under this computer's key) until the user answers.
    const known = new Set(Object.values(row.tokens));

    if (tokensIn(payload).some((t) => !known.has(t) && !secrets.has(t))) return { outcome: "secrets" };

    const sealed = secrets.size
      ? encryptSecret(hostContext.store.key, JSON.stringify(Object.fromEntries(secrets)))
      : null;

    await hostContext.store.query(
      `INSERT INTO computer_shared_conflicts(owner_user_id,item_key,node_id,local_payload,remote_payload,remote_secrets,remote_clock,remote_digest,remote_changed_at)
        VALUES($1::uuid,$2,$3,$4::jsonb,$5::jsonb,$6,$7::jsonb,$8,$9) ON CONFLICT(owner_user_id,item_key,node_id) DO UPDATE SET local_payload=excluded.local_payload,
        remote_payload=excluded.remote_payload,remote_secrets=coalesce(excluded.remote_secrets,computer_shared_conflicts.remote_secrets),remote_clock=excluded.remote_clock,
        remote_changed_at=excluded.remote_changed_at,remote_digest=excluded.remote_digest,
        detected_at=CASE WHEN computer_shared_conflicts.remote_digest=excluded.remote_digest THEN computer_shared_conflicts.detected_at ELSE now() END`,
      [
        hostContext.store.owner,
        item.key,
        node,
        current ? JSON.stringify(current.payload) : null,
        item.payload,
        sealed,
        JSON.stringify(clock),
        item.digest,
        new Date(Number(item.changedAtMs)),
      ],
    );

    return { outcome: "conflict" };
  }

  const written = await sharedWrite(hostContext, key, payload, secrets, current);

  if (written.outcome !== "applied") return written;
  const after = await hostContext.read(key, written.tokens);
  await sharedSave(hostContext, {
    ...row,
    shared: true,
    clock: merge(row.clock, clock),
    digest: after ? digestOf(after.payload) : item.digest,
    changed_by: item.changedBy,
    changed_at: new Date(Number(item.changedAtMs)),
    tokens: after?.tokens ?? {},
    note: "",
  });
  await hostContext.store.query(
    "DELETE FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2 AND node_id=$3",
    [hostContext.store.owner, item.key, node],
  );
  await sharedAck(hostContext, node, item.key, item.digest);

  return { outcome: "applied" };
}

export interface SharedSyncMethods {
  scan(): Promise<boolean>;
  push(node: string, full?: boolean): Promise<void>;
  receive(node: string, push: link.SharedConfigPush): Promise<link.SharedConfigReply>;
}

export const sharedSyncMethods: SharedSyncMethods = {
  // ------------------------------------------------------------------ this computer's changes

  /** Notices local edits and deletions of shared items: a new version by this computer. */
  scan(this: SharedConfig): Promise<boolean> {
    return sharedExclusive(this, async () => {
      let changed = false;

      for (const row of [...this[sharedState].rows.values()].filter((r) => r.shared)) {
        const key = parseSharedKey(row.item_key);

        if (!key) continue;
        const value = await this.read(key, row.tokens);

        if (!value) {
          // Deleted or archived here. Other computers keep their copies as local items.
          await sharedSave(this, {
            ...row,
            shared: false,
            clock: bump(row.clock, this.peers.self()),
            digest: "",
            changed_by: this.peers.self(),
            changed_at: new Date(),
            note: "deleted",
          });
          await this.store.query("DELETE FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2", [
            this.store.owner,
            row.item_key,
          ]);
          changed = true;
          continue;
        }

        const digest = digestOf(value.payload);

        if (digest !== row.digest) {
          await sharedSave(this, {
            ...row,
            clock: bump(row.clock, this.peers.self()),
            digest,
            changed_by: this.peers.self(),
            changed_at: new Date(),
            tokens: value.tokens,
          });
          changed = true;
        } else if (canonicalJson(value.tokens) !== canonicalJson(row.tokens))
          await sharedSave(this, { ...row, tokens: value.tokens });
      }

      if (changed) this.changed();

      return changed;
    });
  },

  /** Sends a peer every item it has not confirmed. `full`: everything shared (after a reconnect). */
  async push(this: SharedConfig, node: string, full = false): Promise<void> {
    // A push already running sends again afterwards: it may have read the state before this change.
    if (this[sharedState].pushing.has(node)) {
      this[sharedState].again.add(node);

      return;
    }

    this[sharedState].pushing.add(node);

    try {
      for (let round = 0; round < 6; round++) {
        this[sharedState].again.delete(node);
        const items = await sharedExclusive(this, () => sharedOutgoing(this, node, full && round === 0));

        if (!items.length) {
          if (this[sharedState].again.has(node)) continue;

          return;
        }

        const method = link.SharedConfigService.method.pushSharedConfig;
        let reply: link.SharedConfigReply | undefined;

        for await (const message of this.peers.call(
          node,
          method,
          create(link.SharedConfigPushSchema, { items }),
          AbortSignal.timeout(PUSH_TIMEOUT_MS),
        )) {
          reply = linkedMessage(link.SharedConfigReplySchema, message);
          break;
        }

        if (!reply) return;

        const resend = await sharedExclusive(this, async () => {
          let again = false;
          const sent = new Map(items.map((i) => [i.key, i]));

          for (const result of reply!.results) {
            const item = sent.get(result.key);

            if (!item) continue;

            if (result.outcome === "applied" || result.outcome === "same") {
              await sharedAck(this, node, item.key, item.digest, true);
              // The peer has exactly this value: take in its versions and drop any question about it.
              const row = this[sharedState].rows.get(item.key);

              if (row?.shared && row.digest === item.digest) {
                const clock = merge(row.clock, fromWire(result.clock));

                if (canonicalJson(clock) !== canonicalJson(row.clock)) await sharedSave(this, { ...row, clock });

                const removed = await this.store.query(
                  "DELETE FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2 AND node_id=$3 RETURNING item_key",
                  [this.store.owner, item.key, node],
                );

                if (removed.length) this.changed();
              }
            } else if (result.outcome === "unshared") await sharedAck(this, node, item.key, undefined);
            else if (result.outcome === "secrets") {
              await sharedAck(this, node, item.key, undefined);
              again = true;
            }
          }

          return again;
        });

        if (!resend && !this[sharedState].again.has(node)) return;
      }
    } finally {
      this[sharedState].pushing.delete(node);
      this[sharedState].again.delete(node);
    }
  },

  // ------------------------------------------------------------------ another computer's changes

  /** A linked computer's push: apply, keep the newer local value, or ask the user. */
  async receive(this: SharedConfig, node: string, push: link.SharedConfigPush): Promise<link.SharedConfigReply> {
    await this.scan();

    const reply = await sharedExclusive(this, async () => {
      const results: link.SharedItemResult[] = [];
      let changed = false;

      for (const item of push.items.slice(0, 500)) {
        const outcome = await sharedOne(this, node, item).catch(failure);

        if (outcome.outcome !== "same" && outcome.outcome !== "newer") changed = true;
        const settled = outcome.outcome === "same" || outcome.outcome === "applied";
        results.push(
          create(link.SharedItemResultSchema, {
            key: item.key,
            outcome: outcome.outcome,
            digest: item.digest,
            message: outcome.message ?? "",
            ...(settled && { clock: wireClock(sharedRow(this, item.key).clock) }),
          }),
        );
      }

      if (changed) this.changed();

      return create(link.SharedConfigReplySchema, { results });
    });

    return reply;
  },
};
