import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { computerLink as link, Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { configAllowed } from "../../apps/gateway/src/computers/runtime-config.ts";
import { wireItem } from "../../apps/gateway/src/config-sync/merge.ts";
import type { ConfigRow } from "../../apps/gateway/src/config-sync/persistence.ts";
import { configComputer, editInstance, instanceOf, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { eventually } from "./support/gateway.ts";

const wait = async (predicate: () => Promise<boolean> | boolean) =>
  expect(await eventually(async () => predicate(), Boolean, 20_000)).toBe(true);

async function notice(computer: ConfigComputer, field: string) {
  return (await computer.links.snapshot()).configNotices.find((n) => n.reason === "choice" && n.field === field);
}

describe.skipIf(!dockerAvailable)("configuration intent and explicit conflict choices", () => {
  test("choosing an alternative preserves its transitive observations across three computers", async () => {
    const a = await configComputer("Computer A");
    let b: ConfigComputer | undefined;
    let c: ConfigComputer | undefined;

    try {
      b = await configComputer("Computer B");
      await editInstance(a, Provider.CLAUDE, "native", { label: "Original" });
      await pairConfig(a, b);
      const second = b;
      await wait(async () => (await instanceOf(second, Provider.CLAUDE, "native"))?.label === "Original");
      await a.sharing(b.node, false);
      await wait(() => !configAllowed(second.links, a.node));
      await editInstance(a, Provider.CLAUDE, "native", { label: "Alpha" });
      await editInstance(b, Provider.CLAUDE, "native", { label: "Beta" });
      c = await configComputer("Computer C");
      await pairConfig(a, c);
      const third = c;
      await wait(async () => (await instanceOf(third, Provider.CLAUDE, "native"))?.label === "Alpha");
      await a.sharing(c.node, false);
      await wait(() => !configAllowed(third.links, a.node));
      await editInstance(c, Provider.CLAUDE, "native", { label: "Gamma" });
      await pairConfig(b, c);
      await wait(async () => !!(await notice(second, "label")));
      await b.restart();
      const alternative = (await notice(b, "label"))!;
      await b.gateway.api.manageConfigNotice({ id: alternative.id, action: "restore" });
      await wait(async () => (await instanceOf(third, Provider.CLAUDE, "native"))?.label === "Gamma");
      await a.sharing(b.node, true);
      await wait(async () => (await instanceOf(a, Provider.CLAUDE, "native"))?.label === "Gamma");
      expect(await notice(a, "label")).toBeUndefined();
      await wait(async () => !(await notice(third, "label")));
    } finally {
      await c?.close();
      await b?.close();
      await a.close();
    }
  }, 120_000);

  test("two configured computers keep their own values until either choice propagates", async () => {
    const a = await configComputer("Computer A");
    let b: ConfigComputer | undefined;

    try {
      await editInstance(a, Provider.CLAUDE, "native", {
        label: "Claude on A",
        env: [{ name: "ACCOUNT_TOKEN", secret: true, value: "fixture-intent-secret" }],
      });
      b = await configComputer("Computer B");
      await editInstance(b, Provider.CLAUDE, "native", { label: "Claude on B" });
      await a.update({ timezone: "Europe/Warsaw" });
      await b.update({ timezone: "Asia/Tokyo" });
      await pairConfig(a, b);
      const second = b;
      await wait(async () => !!(await notice(a, "label")) && !!(await notice(second, "label")));
      expect((await instanceOf(a, Provider.CLAUDE, "native"))?.label).toBe("Claude on A");
      expect((await instanceOf(b, Provider.CLAUDE, "native"))?.label).toBe("Claude on B");
      expect((await a.settings()).timezone).toBe("Europe/Warsaw");
      expect((await b.settings()).timezone).toBe("Asia/Tokyo");
      await b.restart();
      await wait(async () => !!(await notice(second, "label")));
      const keep = (await notice(a, "label"))!;
      await a.gateway.api.manageConfigNotice({ id: keep.id, action: "dismiss" });
      await wait(async () => (await instanceOf(second, Provider.CLAUDE, "native"))?.label === "Claude on A");
      const useOther = (await notice(a, "timezone"))!;
      await a.gateway.api.manageConfigNotice({ id: useOther.id, action: "restore" });
      await wait(async () => (await a.settings()).timezone === "Asia/Tokyo");
      await wait(async () => !(await notice(second, "label")) && !(await notice(second, "timezone")));
      expect((await instanceOf(a, Provider.CLAUDE, "native"))?.env[0]?.secret).toBe(true);
    } finally {
      await b?.close();
      await a.close();
    }
  }, 120_000);

  test("a legacy fresh snapshot cannot clear a secret, while an explicit reset remains an edit", async () => {
    const a = await configComputer("Configured computer");
    let b: ConfigComputer | undefined;

    try {
      await editInstance(a, Provider.CLAUDE, "native", {
        label: "Configured",
        env: [{ name: "ACCOUNT_TOKEN", secret: true, value: "fixture-never-clear" }],
      });
      b = await configComputer("Fresh computer");
      await pairConfig(a, b);
      const second = b;
      await wait(() => configAllowed(a.links, second.node) && configAllowed(second.links, a.node));
      await wait(async () => (await instanceOf(second, Provider.CLAUDE, "native"))?.label === "Configured");

      const row = (
        await b.store.query<ConfigRow>("SELECT * FROM config_items WHERE kind='instance' AND global_id='claude:native'")
      )[0]!;

      const empty = wireItem(row);
      const future = `${Date.now() + 60_000}.0.${b.node}`;
      empty.fields = {
        label: create(link.ConfigFieldSchema, { valueJson: '""', hlc: future }),
        "env.ACCOUNT_TOKEN": create(link.ConfigFieldSchema, { valueJson: "null", hlc: future, edited: false }),
      };
      await a.links.config!.receive(b.node, create(link.ConfigUpdateSchema, { items: [empty] }), () => true);
      const configured = (await instanceOf(a, Provider.CLAUDE, "native"))!;
      expect(configured.label).toBe("Configured");
      expect(configured.env[0]?.secret).toBe(true);

      const profile = a.gateway.worker.configs
        .at(-1)
        ?.profiles.find((p) => p.id === "native" && p.providers.includes(Provider.CLAUDE));

      expect(profile?.env.some((v) => v.name === "ACCOUNT_TOKEN" && v.value === "fixture-never-clear")).toBe(true);
      // An actual user clearing a field after seeing it is intentional, including a reset to the default.
      await editInstance(a, Provider.CLAUDE, "native", { label: "" });
      await wait(async () => (await instanceOf(second, Provider.CLAUDE, "native"))?.label === "");
      await a.restart();
      expect((await instanceOf(a, Provider.CLAUDE, "native"))?.label).toBe("");
    } finally {
      await b?.close();
      await a.close();
    }
  }, 120_000);
});
