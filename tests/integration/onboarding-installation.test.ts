import { expect, test } from "bun:test";
import { migrations, migrate } from "@canopy/db";
import { dockerAvailable, startPostgres } from "@canopy/db/testing";
import { Effect, ManagedRuntime } from "effect";
import { Migrator } from "effect/sql";
import { offerGatewayOnboarding } from "../../apps/gateway/src/store/gateway-onboarding.ts";

test.skipIf(!dockerAvailable)(
  "a new gateway offers onboarding through restarts of its initial version",
  async () => {
    const pg = await startPostgres({ migrated: true });
    const runtime = ManagedRuntime.make(pg.layer);

    try {
      expect(await runtime.runPromise(offerGatewayOnboarding("1.0.0"))).toBe(true);
      expect(await runtime.runPromise(migrate)).toEqual([]);
      expect(await runtime.runPromise(offerGatewayOnboarding("1.0.0"))).toBe(true);
      expect(await runtime.runPromise(offerGatewayOnboarding("1.1.0"))).toBe(false);
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable)(
  "upgrading an existing gateway with no user data never enables onboarding",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);

    try {
      await runtime.runPromise(
        Migrator.make({})({
          loader: Effect.map(migrations, (all) => all.filter(([id]) => id < 192)),
          table: "schema_migrations",
        }),
      );
      expect(await runtime.runPromise(migrate)).toContainEqual([192, "gateway_onboarding"]);
      expect(await runtime.runPromise(offerGatewayOnboarding("1.1.0"))).toBe(false);
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
