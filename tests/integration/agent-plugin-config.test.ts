import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { EnvironmentResolutionSchema } from "@canopy/contracts";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { tempDirs } from "@canopy/testing";
import { InstructionLedger } from "../../apps/worker/src/agent-environment/ledger.ts";
import { managedPlugins } from "../../apps/worker/src/agent-environment/plugin-loading.ts";
import {
  observedPluginConfig,
  pluginConfigCheck,
  pluginIndexPath,
  reconcilePluginConfig,
  type PluginConfigTarget,
} from "../../apps/worker/src/agent-environment/plugin-config.ts";

const scratch = tempDirs();

function fixture() {
  const root = scratch("canopy-plugin-config-");
  const home = join(root, "home");
  const dataDir = join(root, "data");

  const target = {
    path: join(home, "settings.json"),
    harness: "claude",
    scope: "platform",
    active: true,
    content: {
      kind: "json",
      value: {
        enabledPlugins: { "zeta@canopy-zeta": true, "alpha@canopy-alpha": true },
        extraKnownMarketplaces: {
          "canopy-zeta": { source: { source: "directory", path: join(root, "reviewed") }, autoUpdate: false },
        },
      },
    },
  } satisfies PluginConfigTarget;

  return { home, dataDir, target, ledger: new InstructionLedger(dataDir, "plugin-config.json") };
}

function receipt(f: ReturnType<typeof fixture>, checksum = pluginConfigCheck(f.target).checksum) {
  return {
    ...f.target,
    path: pluginIndexPath(f.home, "claude"),
    content: {
      kind: "json",
      value: {
        plugins: {},
        checks: { "canopy-settings": { ...pluginConfigCheck(f.target), checksum } },
        status: { "canopy-state": { blocked: false } },
      },
    },
  } satisfies PluginConfigTarget;
}

function reorderSettings(f: ReturnType<typeof fixture>) {
  const value = f.target.content.value;
  const market = value.extraKnownMarketplaces["canopy-zeta"];
  writeFileSync(
    f.target.path,
    JSON.stringify({
      extraKnownMarketplaces: {
        "canopy-zeta": { autoUpdate: market.autoUpdate, source: { path: market.source.path, source: "directory" } },
      },
      enabledPlugins: { "alpha@canopy-alpha": true, "zeta@canopy-zeta": true },
      env: { PRIVATE_FIXTURE: "never-report" },
    }),
  );
}

function legacyState(target: PluginConfigTarget, ledger: InstructionLedger) {
  if (target.content.kind !== "json") throw new Error("Expected a JSON fixture.");
  const checksum = environmentDigest(JSON.stringify(target.content.value));
  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, `${JSON.stringify(target.content.value, null, 2)}\n`);
  const targetId = environmentDigest(target.path);
  ledger.commit(targetId, {
    targetId,
    path: target.path,
    harness: target.harness,
    scope: target.scope,
    checksum,
  });

  return checksum;
}

describe("managed plugin activation JSON on disk", () => {
  test("nested object key order does not drift or invalidate a launch receipt", () => {
    const f = fixture();
    expect(reconcilePluginConfig(f.target, f.ledger).status).toBe("applied");
    expect(reconcilePluginConfig(receipt(f), f.ledger).status).toBe("applied");
    expect(managedPlugins(f.home, "claude")).toEqual([]);
    reorderSettings(f);
    const check = pluginConfigCheck(f.target);
    writeFileSync(
      pluginIndexPath(f.home, "claude"),
      JSON.stringify({
        status: { "canopy-state": { blocked: false } },
        checks: {
          "canopy-settings": { checksum: check.checksum, fields: check.fields, kind: check.kind, path: check.path },
        },
        plugins: {},
      }),
    );
    expect(managedPlugins(f.home, "claude")).toEqual([]);
    const restarted = new InstructionLedger(f.dataDir, "plugin-config.json");
    expect(reconcilePluginConfig(f.target, restarted).status).toBe("applied");
    expect(reconcilePluginConfig(receipt(f), restarted).status).toBe("applied");
    expect(readFileSync(f.target.path, "utf8")).toContain("never-report");
    expect(managedPlugins(f.home, "claude")).toEqual([]);
  });

  test("legacy ledgers and launch receipts upgrade after a restart and recover order-only drift", () => {
    const f = fixture();
    const legacyChecksum = legacyState(f.target, f.ledger);
    expect(legacyChecksum).not.toBe(pluginConfigCheck(f.target).checksum);
    legacyState(receipt(f, legacyChecksum), f.ledger);
    expect(managedPlugins(f.home, "claude")).toEqual([]);

    const restarted = new InstructionLedger(f.dataDir, "plugin-config.json");
    reorderSettings(f);
    expect(reconcilePluginConfig(f.target, restarted).status).toBe("applied");
    expect(reconcilePluginConfig(receipt(f), restarted).status).toBe("applied");
    expect(restarted.entries.get(environmentDigest(f.target.path))?.checksum).toBe(
      pluginConfigCheck(f.target).checksum,
    );
    expect(managedPlugins(f.home, "claude")).toEqual([]);
  });

  test("legacy ownership permits an approved update while changed local values still drift", () => {
    const f = fixture();
    legacyState(f.target, f.ledger);

    const changed = {
      ...f.target,
      content: {
        kind: "json",
        value: { ...f.target.content.value, enabledPlugins: { "zeta@canopy-zeta": false, "alpha@canopy-alpha": true } },
      },
    } satisfies PluginConfigTarget;

    const restarted = new InstructionLedger(f.dataDir, "plugin-config.json");
    expect(reconcilePluginConfig(changed, restarted).status).toBe("applied");

    const dirty = fixture();
    legacyState(dirty.target, dirty.ledger);
    writeFileSync(dirty.target.path, readFileSync(dirty.target.path, "utf8").replace(": true", ": false"));
    const status = reconcilePluginConfig(dirty.target, new InstructionLedger(dirty.dataDir, "plugin-config.json"));
    expect(status.status).toBe("drift");
  });

  test("an existing keep decision survives canonical hashing until the observed bytes change", () => {
    const f = fixture();
    const legacyDesired = legacyState(f.target, f.ledger);
    writeFileSync(f.target.path, readFileSync(f.target.path, "utf8").replace(": true", ": false"));
    const drift = reconcilePluginConfig(f.target, f.ledger);
    const entry = f.ledger.entries.get(drift.targetId)!;
    f.ledger.commit(drift.targetId, { ...entry, keptDesired: legacyDesired, keptObserved: drift.observedChecksum });
    const restarted = new InstructionLedger(f.dataDir, "plugin-config.json");
    expect(reconcilePluginConfig(f.target, restarted).status).toBe("kept");
    expect(restarted.entries.get(drift.targetId)?.keptDesired).toBe(pluginConfigCheck(f.target).checksum);
    writeFileSync(f.target.path, readFileSync(f.target.path, "utf8").replace(": true", ": false"));
    expect(reconcilePluginConfig(f.target, restarted).status).toBe("drift");
  });

  test("real activation edits block launch, survive restart and require a current overwrite CAS", () => {
    const f = fixture();
    reconcilePluginConfig(f.target, f.ledger);
    reconcilePluginConfig(receipt(f), f.ledger);
    const original = readFileSync(f.target.path, "utf8");
    writeFileSync(f.target.path, original.replace('"zeta@canopy-zeta": true', '"zeta@canopy-zeta": false'));
    expect(() => managedPlugins(f.home, "claude")).toThrow("activation changed");
    const restarted = new InstructionLedger(f.dataDir, "plugin-config.json");
    const drift = reconcilePluginConfig(f.target, restarted);
    expect(drift.status).toBe("drift");

    const overwrite = create(EnvironmentResolutionSchema, {
      action: "overwrite",
      observedChecksum: drift.observedChecksum,
      desiredChecksum: drift.desiredChecksum,
    });

    writeFileSync(f.target.path, original.replaceAll(": true", ": false"));
    const stale = reconcilePluginConfig(f.target, restarted, overwrite);
    expect(stale.status).toBe("drift");
    expect(() => managedPlugins(f.home, "claude")).toThrow("activation changed");
    expect(
      reconcilePluginConfig(
        f.target,
        restarted,
        create(EnvironmentResolutionSchema, { ...overwrite, observedChecksum: stale.observedChecksum }),
      ).status,
    ).toBe("applied");
    expect(managedPlugins(f.home, "claude")).toEqual([]);
  });

  test("registry entry key order is immaterial while array order remains significant", () => {
    const f = fixture();

    const entries = [
      { scope: "user", installPath: join(f.home, "first"), version: "local" },
      { scope: "project", installPath: join(f.home, "second"), version: "local" },
    ];

    const target = {
      ...f.target,
      path: join(f.home, "plugins/installed_plugins.json"),
      content: { kind: "json", value: { plugins: { "zeta@canopy-zeta": entries } } },
    } satisfies PluginConfigTarget;

    expect(reconcilePluginConfig(target, f.ledger).status).toBe("applied");
    const check = pluginConfigCheck(target);

    const reordered = entries.map((entry) => ({
      version: entry.version,
      installPath: entry.installPath,
      scope: entry.scope,
    }));

    writeFileSync(target.path, JSON.stringify({ version: 2, plugins: { "zeta@canopy-zeta": reordered } }));
    expect(observedPluginConfig(check)).toBe(check.checksum);
    expect(reconcilePluginConfig(target, f.ledger).status).toBe("applied");
    writeFileSync(target.path, JSON.stringify({ version: 2, plugins: { "zeta@canopy-zeta": reordered.toReversed() } }));
    expect(observedPluginConfig(check)).not.toBe(check.checksum);
    expect(reconcilePluginConfig(target, f.ledger).status).toBe("drift");
  });

  test("matching unowned settings are never adopted, including through overwrite", () => {
    const f = fixture();
    mkdirSync(f.home, { recursive: true });
    writeFileSync(f.target.path, JSON.stringify(f.target.content.value));
    const drift = reconcilePluginConfig(f.target, f.ledger);
    expect(drift.status).toBe("drift");
    expect(drift.owned).toBe(false);
    expect(
      reconcilePluginConfig(
        f.target,
        f.ledger,
        create(EnvironmentResolutionSchema, {
          action: "overwrite",
          observedChecksum: drift.observedChecksum,
          desiredChecksum: drift.desiredChecksum,
        }),
      ).status,
    ).toBe("drift");
  });
});
