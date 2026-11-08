import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { DEPARTURE_WINDOW_MS } from "@canopy/domain/computer-presence";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime, GatewayCore } from "../core/core.ts";
import type { GatewayCoreOptions } from "../core/core-context.ts";
import { CANOPY_VERSION } from "@canopy/domain/release/version";

export function createGatewayDepartures(core: GatewayCore, options: GatewayCoreOptions) {
  return new GatewayDepartures(
    options.runtime,
    options.userId,
    options.updates?.version ?? CANOPY_VERSION,
    (value) =>
      core.hub.publishOverview(create(ui.OverviewUpdateSchema, { change: { case: "gatewayDeparture", value } })),
    async (state) => {
      await core.computers?.announce(state);
    },
    () => core.computers?.hello().name ?? "this computer",
  );
}

/** Private, owner-scoped checkpoint. It survives replacement of the gateway and desktop bundle. */
export class GatewayDepartures {
  private queue = Promise.resolve();
  constructor(
    readonly runtime: CoreRuntime,
    readonly owner: string,
    readonly version: string,
    readonly publish: (value: ui.GatewayDeparture) => void,
    readonly presence: (state: string) => Promise<void>,
    readonly name: () => string,
  ) {}

  async snapshot(): Promise<ui.GatewayDeparture | undefined> {
    const owner = this.owner;

    const rows = await this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<{ value: JsonValue | null }>`SELECT settings->'gatewayDeparture' AS value
        FROM user_settings WHERE user_id = ${owner}::uuid`;
      }),
    );

    return rows[0]?.value ? fromJson(ui.GatewayDepartureSchema, rows[0].value) : undefined;
  }

  announce(state: "updating" | "restarting", targetVersion = "") {
    return this.serialize(async () => {
      const previous = await this.snapshot();

      const continuing =
        previous &&
        ["updating", "restarting"].includes(previous.state) &&
        Date.now() < Number(previous.startedAtMs) + previous.windowMs;

      const value = create(ui.GatewayDepartureSchema, {
        id: continuing ? previous.id : crypto.randomUUID(),
        state,
        targetVersion: targetVersion || (continuing ? previous.targetVersion : ""),
        startedAtMs: continuing ? previous.startedAtMs : BigInt(Date.now()),
        windowMs: DEPARTURE_WINDOW_MS,
        version: this.version,
        name: this.name(),
      });

      await this.write(value);
      await this.presence(state);
    });
  }

  /** Called after the updater's startup checkpoint, or with the desktop journal's authoritative outcome. */
  recover(state = "", reason = "", targetVersion = "") {
    return this.serialize(async () => {
      const previous = await this.snapshot();

      if (!previous || !["updating", "restarting"].includes(previous.state)) return;

      const failed =
        ["failed", "rolled_back"].includes(state) && (!targetVersion || targetVersion === previous.targetVersion);

      const reached = !previous.targetVersion || previous.targetVersion === this.version;
      await this.write(
        create(ui.GatewayDepartureSchema, {
          ...previous,
          version: this.version,
          state: failed ? state : reached ? "succeeded" : "failed",
          reason: failed
            ? reason
            : reached
              ? ""
              : "The computer returned without the requested update. Open Updates to retry.",
        }),
      );
      await this.presence("connected");
    });
  }

  private async write(value: ui.GatewayDeparture) {
    const owner = this.owner;
    const json = JSON.stringify({ gatewayDeparture: toJson(ui.GatewayDepartureSchema, value) });
    await this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO user_settings (user_id, settings, version) VALUES (${owner}::uuid, ${json}::jsonb, 1)
        ON CONFLICT (user_id) DO UPDATE SET settings = user_settings.settings || EXCLUDED.settings, updated_at = now()`;
      }),
    );
    this.publish(value);
  }

  private serialize(run: () => Promise<void>) {
    const next = this.queue.then(run);
    this.queue = next.catch(() => {});

    return next;
  }
}
