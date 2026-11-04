import { MentionKind } from "@canopy/contracts";
import type { v2 } from "@canopy/codex-protocol";
import type { MentionEntryInit } from "../../mentions/catalog.ts";
import { catalogIcon } from "../../mentions/icons.ts";

type EntryInit = MentionEntryInit;

/**
 * What Codex offers the composer (docs/codex-adapter.md, "Wzmianki"), from the app-server without a model turn:
 * - skills: `skills/list` for the thread's folder (scopes: repo, user = $CODEX_HOME/skills and the device owner's
 *   ~/.agents/skills, system = bundled with Codex, admin); disabled ones are left out;
 * - plugins: installed and enabled ones from `plugin/list` (mention path plugin://<id>, id = name@marketplace);
 * - apps (connectors): `app/list`, only when the worker enables connectors; accessible and enabled ones (app://<id>);
 * - commands: none. Codex's slash commands are features of its TUI, not of turn input; the app-server has methods
 *   for some (review/start, thread/compact/start) that the platform does not expose yet.
 */

export function codexSkillEntries(listed: v2.SkillsListResponse): { entries: EntryInit[]; notes: string[] } {
  const entries: EntryInit[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const group of listed.data) {
    for (const skill of group.skills) {
      if (!skill.enabled || seen.has(skill.name)) continue;
      seen.add(skill.name);
      entries.push({
        kind: MentionKind.SKILL,
        name: skill.name,
        label: skill.interface?.displayName ?? "",
        description: skill.interface?.shortDescription ?? skill.shortDescription ?? skill.description,
        source: skill.scope === "repo" ? "project" : skill.scope,
        path: skill.path,
        icon: catalogIcon(skill.interface?.iconSmall ?? skill.interface?.iconSmallUrl),
        color: skill.interface?.brandColor ?? "",
        plugin: skill.pluginId ?? "",
      });
    }

    for (const error of group.errors) notes.push(`skill ${error.path}: ${error.message}`);
  }

  return { entries, notes };
}

export function codexPluginEntries(listed: v2.PluginListResponse): EntryInit[] {
  const entries: EntryInit[] = [];

  for (const marketplace of listed.marketplaces) {
    for (const plugin of marketplace.plugins) {
      if (!plugin.installed || !plugin.enabled) continue;
      const ui = plugin.interface;
      entries.push({
        kind: MentionKind.PLUGIN,
        name: plugin.name,
        label: ui?.displayName ?? "",
        description: ui?.shortDescription ?? "",
        source: "plugin",
        path: `plugin://${plugin.id}`,
        icon: catalogIcon(ui?.composerIcon ?? ui?.composerIconUrl ?? ui?.logo ?? ui?.logoUrl),
        color: ui?.brandColor ?? "",
      });
    }
  }

  return entries;
}

export function codexAppEntries(listed: v2.AppsListResponse): EntryInit[] {
  return listed.data
    .filter((app) => app.isAccessible && app.isEnabled)
    .map((app) => ({
      kind: MentionKind.PLUGIN,
      // The text form Codex documents for apps: [$app-name](app://<id>).
      name: slug(app.name),
      label: app.name,
      description: app.description ?? "",
      source: "app",
      path: `app://${app.id}`,
      icon: catalogIcon(app.logoUrl),
    }));
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "") || "app"
  );
}
