import { create } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { setTimeout } from "node:timers/promises";
import { type ConfigSync } from "./engine.ts";
import { wireItem } from "./merge.ts";
import type { ClockRow, ConfigRow } from "./persistence.ts";

export async function* watchConfig(sync: ConfigSync, cursor: string, signal: AbortSignal, allowed: () => boolean) {
  if (!allowed()) throw new ConnectError("Configuration sharing is off", Code.FailedPrecondition);
  yield create(link.ConfigUpdateSchema, { hello: { schemas: { settings: 1, computer: 1 } } });
  let checkpoint = cursor;

  while (!signal.aborted) {
    if (!allowed()) throw new ConnectError("Configuration sharing is off", Code.FailedPrecondition);

    const clock = (
      await sync.store.query<ClockRow>("SELECT * FROM config_clock WHERE owner_user_id=$1::uuid", [sync.store.owner])
    )[0]!;

    const [epoch, revision] = checkpoint.split(":");
    const reset = epoch !== clock.epoch || !/^\d+$/.test(revision ?? "") || BigInt(revision!) > BigInt(clock.revision);
    const after = reset ? "0" : revision!;

    // A commit can overtake the clock read. Bound this batch by the committed clock, so no cursor skips it.
    const rows = await sync.store.query<ConfigRow>(
      `SELECT * FROM config_items WHERE owner_user_id=$1::uuid
      AND revision>$2::bigint AND revision<=$3::bigint ORDER BY revision LIMIT 100`,
      [sync.store.owner, after, clock.revision],
    );

    const nextRevision = rows.length === 100 ? rows.at(-1)!.revision : clock.revision;
    const next = `${clock.epoch}:${nextRevision}`;

    if (reset || rows.length || checkpoint !== next) {
      if (!allowed()) throw new ConnectError("Configuration sharing is off", Code.FailedPrecondition);
      yield create(link.ConfigUpdateSchema, { items: rows.map(wireItem), checkpoint: next, reset });
      checkpoint = next;
    }

    if (rows.length < 100) await setTimeout(250, undefined, { signal }).catch(() => {});
  }
}
