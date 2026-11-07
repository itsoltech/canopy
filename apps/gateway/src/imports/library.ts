import { create } from "@bufbuild/protobuf";
import { connectors, PermissionMode, Provider, ui, type ImportLibraryItem, type ModelInfo } from "@canopy/contracts";
import { connectorCandidates, marketplaceCandidates, pluginCandidates, skillCandidates } from "./library-kinds.ts";
import type { LibraryRow } from "./library-store.ts";

/**
 * Settings and library of the CLIs compared with Canopy (docs/import.md, "Ustawienia i biblioteka"): what an import
 * would change ("Default → claude-opus-5-5"), what is already there, what conflicts, and what stays out and why.
 */

/** Capability of workers whose scan lists settings and library items. */
export const CLI_IMPORT_LIBRARY = "cli_import_library_v1";

export const CLI_NAMES = new Map([
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["grok", "Grok"],
]);

export const PROVIDERS = new Map([
  ["claude", Provider.CLAUDE],
  ["codex", Provider.CODEX],
  ["grok", Provider.GROK],
]);

export const MODES = new Map([
  ["ask", PermissionMode.ASK],
  ["accept_edits", PermissionMode.ACCEPT_EDITS],
  ["read_only", PermissionMode.READ_ONLY],
  ["full_auto", PermissionMode.FULL_AUTO],
]);

export const MODE_LABELS = new Map([
  [PermissionMode.ASK, "Ask first"],
  [PermissionMode.ACCEPT_EDITS, "Accept edits"],
  [PermissionMode.READ_ONLY, "Read only"],
  [PermissionMode.FULL_AUTO, "Full auto"],
  [PermissionMode.FULL_ACCESS, "Full access"],
]);

export interface LibraryContext {
  readonly workerName: string;
  readonly defaults: ui.ThreadDefaults;
  /** Models of the worker's own instance per provider; absent = no catalog reported yet. */
  readonly catalogs: ReadonlyMap<Provider, readonly ModelInfo[]>;
  readonly documents: readonly ui.InstructionDocument[];
  readonly skills: readonly ui.LibrarySkill[];
  readonly marketplaces: readonly ui.EnvironmentMarketplace[];
  readonly connectors: readonly connectors.ConnectorAccount[];
  readonly live: readonly LibraryRow[];
}

export const cliName = (cli: string) => CLI_NAMES.get(cli) ?? cli;

/** The instruction document an import creates for a CLI's file on a worker. */
export function documentName(item: Pick<ImportLibraryItem, "agentCli" | "name">, workerName: string): string {
  return `${cliName(item.agentCli)} ${item.name} (${workerName})`;
}

export const liveKey = (i: { rootId: string; agentCli: string; kind: string; name: string; digest: string }) =>
  `${i.rootId}:${i.agentCli}:${i.kind}:${i.name}:${i.digest}`;

export const rowKey = (r: LibraryRow) =>
  liveKey({ rootId: r.root_id, agentCli: r.agent_cli, kind: r.kind, name: r.name, digest: r.digest });

type Fields = Omit<ui.ImportLibraryCandidate, "$typeName" | "$unknown" | "key" | "agentCli" | "kind" | "bytes">;

function candidate(item: ImportLibraryItem, fields: Partial<Fields>): ui.ImportLibraryCandidate {
  return create(ui.ImportLibraryCandidateSchema, {
    key: item.sourceKey,
    agentCli: item.agentCli,
    kind: item.kind,
    bytes: item.bytes,
    name: item.name,
    detail: item.detail,
    warnings: [...item.warnings],
    ...fields,
  });
}

function unavailable(item: ImportLibraryItem, name: string, reason: string): ui.ImportLibraryCandidate {
  return candidate(item, { name, status: "unavailable", reason, current: "", proposed: item.detail });
}

export function libraryCandidates(
  items: readonly ImportLibraryItem[],
  context: LibraryContext,
): ui.ImportLibraryCandidate[] {
  const live = new Set(context.live.map(rowKey));
  const permissions = new Set(items.flatMap((i) => (i.name === "permissions" && !i.reason ? [i.value] : [])));
  const settings = items.filter((i) => i.kind === "setting" || i.kind === "instruction");

  return [
    ...settings.map((item) => settingOrInstruction(item, context, live, permissions)),
    ...skillCandidates(items, context, live),
    ...marketplaceCandidates(items, context, live),
    ...pluginCandidates(items),
    ...connectorCandidates(items, context, live),
  ];
}

function settingOrInstruction(
  item: ImportLibraryItem,
  context: LibraryContext,
  live: ReadonlySet<string>,
  permissions: ReadonlySet<string>,
): ui.ImportLibraryCandidate {
  if (item.kind === "instruction") return instruction(item, context, live);

  if (item.name === "model") return model(item, context);

  if (item.name === "permissions") {
    const result = permission(item, context);

    // Two CLIs propose different modes for the one default: the owner chooses.
    if (permissions.size > 1 && result.status === "new") {
      result.suggested = false;
      result.warnings.push("The CLIs differ here. Choose one.");
    }

    return result;
  }

  return unavailable(item, item.name === "effort" ? "Default effort" : item.name, item.reason);
}

function model(item: ImportLibraryItem, context: LibraryContext): ui.ImportLibraryCandidate {
  const name = `Default model for ${cliName(item.agentCli)}`;

  if (item.reason) return unavailable(item, name, item.reason);
  const provider = PROVIDERS.get(item.agentCli) ?? Provider.UNSPECIFIED;
  const current = context.defaults.models.find((m) => m.provider === provider)?.model ?? "";
  const catalog = context.catalogs.get(provider);

  if (catalog && catalog.length > 0 && !catalog.some((m) => m.id === item.value || m.resolvedModel === item.value))
    return unavailable(item, name, `${item.value} is not available on ${context.workerName}.`);
  const same = current === item.value;

  return candidate(item, {
    name,
    current: current || "Default",
    proposed: item.value,
    status: same ? "same" : "new",
    suggested: !same,
  });
}

function permission(item: ImportLibraryItem, context: LibraryContext): ui.ImportLibraryCandidate {
  const name = "Permissions of new threads";
  const mode = MODES.get(item.value);

  if (item.reason || mode === undefined) return unavailable(item, name, item.reason || "Canopy has no matching mode.");
  const current = context.defaults.permissionMode;
  const same = current === mode;

  return candidate(item, {
    name,
    current: MODE_LABELS.get(current) ?? "Ask first",
    proposed: MODE_LABELS.get(mode) ?? "",
    detail: `${cliName(item.agentCli)}: ${item.detail}`,
    status: same ? "same" : "new",
    suggested: !same,
  });
}

function instruction(
  item: ImportLibraryItem,
  context: LibraryContext,
  live: ReadonlySet<string>,
): ui.ImportLibraryCandidate {
  const name = documentName(item, context.workerName);

  if (item.reason) return unavailable(item, `${cliName(item.agentCli)} ${item.name}`, item.reason);

  if (live.has(liveKey(item))) return candidate(item, { name, status: "imported", suggested: false });
  const existing = context.documents.find((d) => d.name === name && d.harness === item.agentCli);

  return candidate(item, {
    name,
    current: "",
    proposed: existing ? "" : "New instruction document",
    status: existing ? "conflict" : "new",
    reason: existing ? "A document with this name is in Agent environment." : "",
    actions: existing ? ["replace", "keep_both"] : [],
    suggested: !existing,
  });
}

/** Library items the owner may choose, by key: importable now, with the actions they allow. */
export function choosable(candidates: readonly ui.ImportLibraryCandidate[]): Map<string, ui.ImportLibraryCandidate> {
  return new Map(candidates.flatMap((c) => (c.status === "new" || c.status === "conflict" ? [[c.key, c]] : [])));
}
