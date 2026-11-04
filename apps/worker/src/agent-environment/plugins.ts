import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  EnvironmentSkillSchema,
  EnvironmentSkillStatusSchema,
  SkillFileSchema,
  type AgentEnvironmentDesired,
  type EnvironmentSkillStatus,
} from "@canopy/contracts";
import { validatePluginFiles } from "@canopy/domain/plugin-artifact";
import { InstructionLedger } from "./ledger.ts";
import { SkillLedger } from "./skill-ledger.ts";
import { reconcileSkill } from "./skill-reconcile.ts";
import { pluginHome, pluginNamespace, pluginTargets } from "./plugin-targets.ts";
import {
  pluginConfigHome,
  reconcilePluginConfig,
  pluginIndexPath,
  pluginConfigCheck,
  type PluginConfigTarget,
} from "./plugin-config.ts";
import type { EnvironmentHomes } from "./targets.ts";
import type { SkillTarget } from "./skill-targets.ts";

/** Generate a local catalog pointing only at the reviewed bundle; harness auto-updates cannot fetch remote code. */
function localBundle(target: SkillTarget): SkillTarget {
  if (!target.desired?.artifact) return target;
  const plugin = target.desired;
  const artifact = plugin.artifact!;

  const catalog = create(SkillFileSchema, {
    path: ".claude-plugin/marketplace.json",
    content: Buffer.from(
      JSON.stringify({
        name: pluginNamespace(plugin.id, target.harness),
        owner: { name: "Canopy" },
        plugins: [{ name: artifact.name, source: "./" }],
      }),
    ),
  });

  if (artifact.files.some((f) => f.path === catalog.path))
    throw new Error("Plugin bundles must not contain a nested marketplace manifest.");

  return {
    ...target,
    desired: create(EnvironmentSkillSchema, {
      ...plugin,
      artifact: validatePluginFiles([...artifact.files, catalog], { managedCatalog: true }),
    }),
  };
}

export class WorkerPlugins {
  readonly ledger: SkillLedger;
  readonly config: InstructionLedger;
  constructor(dataDir: string) {
    this.ledger = new SkillLedger(dataDir, "plugins.json");
    this.config = new InstructionLedger(dataDir, "plugin-config.json");
  }

  reconcile(desired: AgentEnvironmentDesired, homes: EnvironmentHomes): EnvironmentSkillStatus[] {
    const result: EnvironmentSkillStatus[] = [];
    const targets = pluginTargets(desired, homes, this.ledger).map(localBundle);
    const locations = new Map<string, { home: string; harness: "claude" | "codex"; scope: "device" | "platform" }>();

    for (const target of targets) {
      if (
        (target.harness !== "claude" && target.harness !== "codex") ||
        (target.scope !== "device" && target.scope !== "platform")
      )
        throw new Error("Invalid plugin destination.");
      const home = pluginHome(target.path);
      locations.set(`${target.harness}:${home}`, { home, harness: target.harness, scope: target.scope });
    }

    for (const entry of this.config.entries.values())
      locations.set(`${entry.harness}:${pluginConfigHome(entry.path)}`, {
        home: pluginConfigHome(entry.path),
        harness: entry.harness,
        scope: entry.scope,
      });

    const statusCount =
      targets.length +
      [...locations.values()].reduce((sum, location) => sum + (location.harness === "claude" ? 3 : 2), 0);

    if (statusCount > 512)
      return [
        create(EnvironmentSkillStatusSchema, {
          status: "error",
          detail:
            "This worker exceeds 512 plugin bundle and activation destinations. Reduce its assigned plugins or harness homes before syncing.",
        }),
      ];

    for (const target of targets) {
      const status = reconcileSkill(
        target,
        this.ledger,
        desired.pluginResolutions.find((r) => r.targetId === target.targetId),
        true,
      );

      status.importable = false;

      if (status.status === "applied")
        status.detail = "Reviewed plugin synced. Start a new harness session to load it.";
      result.push(status);
    }

    for (const location of locations.values()) {
      const selected = targets.filter(
        (t) => t.harness === location.harness && pluginHome(t.path) === location.home && t.desired,
      );

      const ready = selected.filter((t) => result.find((s) => s.targetId === t.targetId)?.status === "applied");
      const configs = activationConfigs(location, ready);
      let blocked = ready.length !== selected.length;

      for (const config of configs) {
        const status = reconcilePluginConfig(
          config,
          this.config,
          desired.pluginResolutions.find((r) => r.targetId === Bun.CryptoHasher.hash("sha256", config.path, "hex")),
        );

        if (!["applied", "removed"].includes(status.status)) blocked = true;
        result.push(status);
      }

      const entries = Object.fromEntries(
        ready.map((t) => [
          pluginNamespace(t.skillId, t.harness),
          { path: t.path, checksum: t.desired!.artifact!.checksum },
        ]),
      );

      result.push(
        reconcilePluginConfig(
          {
            ...location,
            path: pluginIndexPath(location.home, location.harness),
            active: selected.length > 0 || blocked,
            content: {
              kind: "json",
              value: {
                plugins: entries,
                checks:
                  selected.length > 0 || blocked
                    ? Object.fromEntries(
                        configs.map((config) => [
                          `canopy-${Bun.CryptoHasher.hash("sha256", config.path, "hex")}`,
                          pluginConfigCheck(config),
                        ]),
                      )
                    : {},
                status: selected.length > 0 || blocked ? { "canopy-state": { blocked } } : {},
              },
            },
          },
          this.config,
          desired.pluginResolutions.find(
            (r) =>
              r.targetId === Bun.CryptoHasher.hash("sha256", pluginIndexPath(location.home, location.harness), "hex"),
          ),
        ),
      );
    }

    return result;
  }
}

function activationConfigs(
  location: { home: string; harness: "claude" | "codex"; scope: "device" | "platform" },
  targets: SkillTarget[],
): PluginConfigTarget[] {
  const active = targets.length > 0;

  if (location.harness === "codex") {
    const desired = targets
      .map((t) => {
        const namespace = pluginNamespace(t.skillId, t.harness);

        return `[plugins.${JSON.stringify(`${t.desired!.artifact!.name}@${namespace}`)}]\nenabled = true\n[marketplaces.${JSON.stringify(namespace)}]\nsource_type = "local"\nsource = ${JSON.stringify(t.path)}\n`;
      })
      .join("");

    return [
      { ...location, path: join(location.home, "config.toml"), active, content: { kind: "toml", value: desired } },
    ];
  }

  const enabled = Object.fromEntries(
    targets.map((t) => [`${t.desired!.artifact!.name}@${pluginNamespace(t.skillId, t.harness)}`, true]),
  );

  const markets = Object.fromEntries(
    targets.map((t) => [
      pluginNamespace(t.skillId, t.harness),
      { source: { source: "directory", path: t.path }, autoUpdate: false },
    ]),
  );

  const plugins = Object.fromEntries(
    targets.map((t) => [
      `${t.desired!.artifact!.name}@${pluginNamespace(t.skillId, t.harness)}`,
      [
        {
          scope: "user",
          installPath: t.path,
          version: "local",
          installedAt: "1970-01-01T00:00:00.000Z",
          lastUpdated: "1970-01-01T00:00:00.000Z",
        },
      ],
    ]),
  );

  return [
    {
      ...location,
      path: join(location.home, "settings.json"),
      active,
      content: { kind: "json", value: { enabledPlugins: enabled, extraKnownMarketplaces: markets } },
    },
    // The version header is handled separately; installed plugin entries remain owner-scoped namespaces.
    {
      ...location,
      path: join(location.home, "plugins/installed_plugins.json"),
      active,
      content: { kind: "json", value: { plugins } },
    },
  ];
}
