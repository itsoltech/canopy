import { create } from "@bufbuild/protobuf";

import { Code, ConnectError } from "@connectrpc/connect";

import { Schema } from "effect";

import { ui } from "@canopy/contracts";

import { parseSharedKey, type SharedKey } from "@canopy/domain/computers";

import { decryptSecret } from "../store/secrets.ts";

import {
  bump,
  differences,
  digestOf,
  HARNESS_LABEL,
  merge,
  SETTINGS_LABEL,
  sharedState,
  type ConflictRow,
} from "./shared-context.ts";
import { sharedExclusive, sharedRow, sharedSave } from "./shared-persistence.ts";
import { sharedWrite } from "./shared-values.ts";
import type { SharedConfig } from "./shared.ts";

export async function sharedLabel(hostContext: SharedConfig, key: SharedKey): Promise<string> {
  if (key.kind === "settings") return SETTINGS_LABEL.get(key.section) ?? key.section;

  if (key.kind === "project")
    return (
      (await hostContext.store.query<{ name: string }>("SELECT name FROM projects WHERE id=$1::uuid", [key.id]))[0]
        ?.name ?? "Project"
    );

  const label = (
    await hostContext.store.query<{ label: string; built_in: boolean }>(
      "SELECT label,built_in FROM provider_instances WHERE harness=$1 AND id=$2",
      [key.harness, key.id],
    )
  )[0];

  const name = `${HARNESS_LABEL.get(key.harness) ?? key.harness} · ${label?.built_in ? "Device login" : label?.label || key.id}`;

  return key.kind === "models" ? `Models of ${name}` : name;
}

export interface SharedManagementMethods {
  manage(operation: ui.SharedConfigOperation): Promise<ui.SharedConfigSnapshot>;
  snapshot(): Promise<ui.SharedConfigSnapshot>;
  changed(): void;
  close(): void;
}

export const sharedManagementMethods: SharedManagementMethods = {
  // ------------------------------------------------------------------ the user's choices

  async manage(this: SharedConfig, operation: ui.SharedConfigOperation): Promise<ui.SharedConfigSnapshot> {
    await this.scan();
    const key = parseSharedKey(operation.key);

    if (!key) throw new ConnectError("This can't be shared", Code.InvalidArgument);
    await sharedExclusive(this, async () => {
      const row = sharedRow(this, operation.key);
      const self = this.peers.self();

      if (operation.action === "share") {
        const value = await this.read(key, row.tokens);

        if (!value)
          throw new ConnectError(
            key.kind === "instance" ? "The built-in login is set up on each computer" : "Not found on this computer",
            Code.NotFound,
          );

        if (
          key.kind === "models" &&
          !sharedRow(this, `instance:${key.harness}:${key.id}`).shared &&
          key.id !== "native"
        )
          throw new ConnectError("Share the provider instance first", Code.FailedPrecondition);

        if (!row.shared)
          await sharedSave(this, {
            ...row,
            shared: true,
            clock: bump(row.clock, self),
            digest: digestOf(value.payload),
            changed_by: self,
            changed_at: new Date(),
            tokens: value.tokens,
            note: "",
          });
      } else if (operation.action === "unshare") {
        if (row.shared)
          await sharedSave(this, {
            ...row,
            shared: false,
            clock: bump(row.clock, self),
            changed_by: self,
            changed_at: new Date(),
            note: "",
          });
        await this.store.query("DELETE FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2", [
          this.store.owner,
          operation.key,
        ]);
      } else if (operation.action === "keep_local" || operation.action === "keep_remote") {
        const conflict = (
          await this.store.query<ConflictRow>(
            "SELECT * FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2 AND node_id=$3",
            [this.store.owner, operation.key, operation.nodeId],
          )
        )[0];

        if (!conflict) throw new ConnectError("This question was already answered", Code.NotFound);
        let value = await this.read(key, row.tokens);

        if (operation.action === "keep_remote") {
          const secrets = new Map(
            Object.entries(
              conflict.remote_secrets
                ? Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
                    JSON.parse(decryptSecret(this.store.key, conflict.remote_secrets)),
                  )
                : {},
            ),
          );

          const written = await sharedWrite(this, key, conflict.remote_payload, secrets, value);

          if (written.outcome !== "applied")
            throw new ConnectError(
              written.message ? `Could not use that version: ${written.message}` : "Could not use that version",
              Code.FailedPrecondition,
            );
          value = await this.read(key, written.tokens);
        } else if (!value) throw new ConnectError("This computer's version no longer exists", Code.FailedPrecondition);
        // The answer is a new version that has seen both: it reaches the other computer and settles its question too.
        await sharedSave(this, {
          ...row,
          shared: true,
          clock: bump(merge(row.clock, conflict.remote_clock), self),
          digest: value ? digestOf(value.payload) : "",
          changed_by: self,
          changed_at: new Date(),
          tokens: value?.tokens ?? {},
          note: "",
        });
        await this.store.query(
          "DELETE FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid AND item_key=$2 AND node_id=$3",
          [this.store.owner, operation.key, operation.nodeId],
        );
      } else throw new ConnectError("Unknown sharing operation", Code.InvalidArgument);
    });
    this.changed();

    for (const node of this.peers.ready()) void this.push(node).catch(() => {});

    return this.snapshot();
  },

  // ------------------------------------------------------------------ what the UI shows

  async snapshot(this: SharedConfig): Promise<ui.SharedConfigSnapshot> {
    const self = this.peers.self();
    const items: ui.SharedConfigItem[] = [];

    for (const row of this[sharedState].rows.values()) {
      const key = parseSharedKey(row.item_key);

      if (!key || (!row.shared && !row.note.includes(":"))) continue;
      const [note, noteNode] = row.note.split(":");
      items.push(
        create(ui.SharedConfigItemSchema, {
          key: row.item_key,
          kind: key.kind,
          label: await sharedLabel(this, key),
          shared: row.shared,
          version: BigInt(Object.values(row.clock).reduce((a, b) => a + b, 0)),
          changedByNodeId: row.changed_by === self ? "" : row.changed_by,
          changedAtMs: BigInt(new Date(row.changed_at).getTime()),
          note: note ?? "",
          noteNodeId: noteNode ?? "",
        }),
      );
    }

    const conflicts: ui.SharedConfigConflict[] = [];

    for (const c of await this.store.query<ConflictRow>(
      "SELECT * FROM computer_shared_conflicts WHERE owner_user_id=$1::uuid ORDER BY detected_at",
      [this.store.owner],
    )) {
      const key = parseSharedKey(c.item_key);

      if (!key) continue;
      const row = sharedRow(this, c.item_key);
      const local = (await this.read(key, row.tokens))?.payload ?? c.local_payload ?? undefined;
      conflicts.push(
        create(ui.SharedConfigConflictSchema, {
          key: c.item_key,
          kind: key.kind,
          label: await sharedLabel(this, key),
          nodeId: c.node_id,
          detectedAtMs: BigInt(new Date(c.detected_at).getTime()),
          remoteChangedAtMs: BigInt(new Date(c.remote_changed_at).getTime()),
          fields: differences(local, c.remote_payload),
        }),
      );
    }

    return create(ui.SharedConfigSnapshotSchema, { items, conflicts, needsUpdateNodeIds: await this.peers.outdated() });
  },

  /** Publishes the current badges and conflicts to the UI (debounced). */
  changed(this: SharedConfig) {
    clearTimeout(this[sharedState].publishTimer);
    this[sharedState].publishTimer = setTimeout(() => {
      void this.snapshot()
        .then((s) => this.host.publish(s))
        .catch(() => {});
    }, 50);
  },

  close(this: SharedConfig) {
    clearTimeout(this[sharedState].publishTimer);
  },
};
