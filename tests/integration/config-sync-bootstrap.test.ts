import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toJsonString } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { configAllowed } from "../../apps/gateway/src/computers/runtime-config.ts";
import { prepareClaudeHome } from "../../apps/worker/src/providers/claude/home.ts";
import { configComputer, editInstance, instanceOf, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually } from "./support/gateway.ts";

const wait = async (predicate: () => Promise<boolean> | boolean) =>
  expect(await eventually(async () => predicate(), Boolean, 20_000)).toBe(true);

describe.skipIf(!dockerAvailable)("first-link provider ownership", () => {
  for (const freshFirst of [false, true]) {
    for (const inviteFromA of [false, true]) {
      test(`configured Claude survives: fresh first=${freshFirst}, invitation from A=${inviteFromA}`, async () => {
        let a: ConfigComputer | undefined;
        let b: ConfigComputer | undefined;

        try {
          if (freshFirst) b = await configComputer("Fresh computer");
          a = await configComputer("Configured computer");
          const home = join(tempDir("link-claude"), "instance");
          const device = join(home, "empty-device");
          mkdirSync(home, { recursive: true });
          writeFileSync(join(home, ".credentials.json"), JSON.stringify({ fixture: "signed-in" }), { mode: 0o600 });
          await editInstance(a, Provider.CLAUDE, "native", {
            label: "Working Claude",
            runtime: { homePath: device, shadowHomePath: home, ownLogin: true, launchArgs: ["--debug"] },
            env: [
              { name: "TEAM", value: "configured" },
              { name: "TEAM_TOKEN", secret: true, value: "fixture-bootstrap-token" },
            ],
          });
          const before = (await instanceOf(a, Provider.CLAUDE, "native"))!;
          await a.gateway.api.setInstanceWorker({
            harness: Provider.CLAUDE,
            id: "native",
            workerId: a.gateway.workerId,
            enabled: true,
            overrides: {
              launchArgsSet: true,
              launchArgs: ["--local-only"],
              env: [{ name: "LOCAL_WORKER", value: "A" }],
            },
          });

          if (!b) b = await configComputer("Fresh computer");
          await pairConfig(inviteFromA ? a : b, inviteFromA ? b : a);
          const first = a;
          const second = b;
          await wait(() => configAllowed(first.links, second.node) && configAllowed(second.links, first.node));
          await wait(async () => (await instanceOf(second, Provider.CLAUDE, "native"))?.env.length === 2);
          const linked = (await instanceOf(a, Provider.CLAUDE, "native"))!;
          expect(linked.label).toBe(before.label);
          expect(linked.runtime).toEqual(before.runtime);
          expect(linked.env).toEqual(before.env);
          // Force another full sync round and bootstrap from durable records.
          await b.restart();
          await wait(() => configAllowed(first.links, second.node) && configAllowed(second.links, first.node));
          const after = (await instanceOf(a, Provider.CLAUDE, "native"))!;
          expect(after.label).toBe(before.label);
          expect(after.runtime).toEqual(before.runtime);
          expect(after.env).toEqual(before.env);
          const onB = (await instanceOf(b, Provider.CLAUDE, "native"))!;
          expect(onB.runtime?.homePath).toBe("");
          expect(onB.runtime?.shadowHomePath).toBe("");

          const localOverrides = await a.store.query<{ overrides: object }>(
            "SELECT overrides FROM provider_instance_workers WHERE worker_id=$1::uuid AND harness='claude' AND instance_id='native'",
            [a.gateway.workerId],
          );

          expect(localOverrides[0]?.overrides).toMatchObject({ launchArgs: ["--local-only"] });

          const freshOverrides = await b.store.query(
            "SELECT 1 FROM provider_instance_workers WHERE worker_id=$1::uuid AND harness='claude' AND instance_id='native'",
            [b.gateway.workerId],
          );

          expect(freshOverrides).toHaveLength(0);

          const profile = a.gateway.worker.configs
            .at(-1)
            ?.profiles.find((p) => p.id === "native" && p.providers.includes(Provider.CLAUDE));

          expect(profile).toBeDefined();
          expect(profile!.ownLogin).toBe(true);
          expect(profile!.env.find((v) => v.name === "TEAM_TOKEN")?.value === "fixture-bootstrap-token").toBe(true);

          const prepared = prepareClaudeHome({
            dataDir: home,
            path: profile!.shadowHomePath,
            deviceClaudeHome: profile!.homePath,
            ownLogin: profile!.ownLogin,
            linkDeviceLogin: true,
          });

          expect(prepared.login).toBe("own");
          expect(existsSync(join(home, ".credentials.json"))).toBe(true);
          expect(
            toJsonString(
              ui.ListProviderInstancesResponseSchema,
              await b.gateway.api.listProviderInstances({}),
            ).includes("fixture-bootstrap-token"),
          ).toBe(false);
        } finally {
          await b?.close();
          await a?.close();
        }
      }, 120_000);
    }
  }
});
