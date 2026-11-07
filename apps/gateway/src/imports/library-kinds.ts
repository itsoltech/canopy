import { create } from "@bufbuild/protobuf";
import { ui, type ImportLibraryItem } from "@canopy/contracts";
import { inspectImportUrl } from "@canopy/domain/import-url";
import { importName } from "@canopy/domain/import-name";
import { cliName, liveKey, type LibraryContext } from "./library.ts";

/**
 * Skills, commands, marketplaces and plugins of the scan compared with the library (docs/import.md, "Skille
 * i pluginy"). The same skill in several CLIs (same name and content) is one candidate for all of them; two
 * versions of one name are both listed and the owner chooses one. Commands and prompts become skills only when
 * chosen. Plugins are listed with what to do: each one needs its own approval in Agent environment.
 */

const ORDER = ["claude", "codex", "grok"];

/** owner/repo and https://github.com/owner/repo(.git) are the same marketplace. */
export function marketplaceSource(source: string): string {
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(source);
  const url = short ? `https://github.com/${short[1]}/${short[2]}` : source;

  return url
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function grouped(items: readonly ImportLibraryItem[], key: (item: ImportLibraryItem) => string) {
  const groups = new Map<string, ImportLibraryItem[]>();

  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);

  return [...groups.values()].map((group) =>
    group.toSorted((a, b) => ORDER.indexOf(a.agentCli) - ORDER.indexOf(b.agentCli)),
  );
}

function base(group: readonly ImportLibraryItem[]) {
  const first = group[0]!;
  const clis = [...new Set(group.map((i) => i.agentCli))];

  return {
    key: first.sourceKey,
    agentCli: first.agentCli,
    agentClis: clis,
    kind: first.kind,
    name: first.name,
    bytes: first.bytes,
    files: first.files,
    warnings: [...new Set(group.flatMap((i) => i.warnings))],
  };
}

export function skillCandidates(
  items: readonly ImportLibraryItem[],
  context: LibraryContext,
  live: ReadonlySet<string>,
): ui.ImportLibraryCandidate[] {
  const groups = grouped(
    items.filter((i) => i.kind === "skill" || i.kind === "command"),
    (i) => `${i.kind === "skill" ? "skill" : "command"}:${i.name}:${i.digest || i.sourceKey}`,
  );

  const versions = new Map<string, number>();

  for (const group of groups)
    if (!group[0]!.reason) versions.set(group[0]!.name, (versions.get(group[0]!.name) ?? 0) + 1);

  return groups.map((group) => {
    const item = group[0]!;
    const common = base(group);
    const clis = common.agentClis.map(cliName).join(", ");
    const what = item.kind === "command" ? `Skill from ${item.detail}` : item.detail;
    const detail = [what, item.source && `from ${item.source}`].filter(Boolean).join(" · ");

    if (item.reason)
      return create(ui.ImportLibraryCandidateSchema, { ...common, detail, status: "unavailable", reason: item.reason });

    if (group.some((i) => live.has(liveKey(i))))
      return create(ui.ImportLibraryCandidateSchema, { ...common, detail, status: "imported" });
    const existing = context.skills.find((s) => s.name === item.name);

    if (existing?.artifact?.checksum === item.digest)
      return create(ui.ImportLibraryCandidateSchema, { ...common, detail, status: "same" });
    const several = (versions.get(item.name) ?? 0) > 1;

    return create(ui.ImportLibraryCandidateSchema, {
      ...common,
      detail,
      status: existing ? "conflict" : "new",
      proposed: existing ? "New version of the library skill" : `New skill for ${clis}`,
      reason: existing ? "A skill with this name is in Agent environment." : "",
      actions: existing ? ["replace"] : [],
      // Commands become skills only when chosen; one of two versions of a name, too.
      suggested: !existing && !several && item.kind === "skill",
      warnings: several ? [...common.warnings, "Another version has this name. Choose one."] : common.warnings,
    });
  });
}

/** User info in a URL (`//user@host`), or what the worker's masking left in its place. */
const SECRET_IN_SOURCE = /\/\/[^/\s]*@|\[redacted\]|\[hidden:/;

const SOURCE_CREDENTIAL =
  "Its URL holds a credential. Add the marketplace in Agent environment with a connected account.";

export function unsafeMarketplaceSource(source: string): boolean {
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) return false;
  const { url, credential } = inspectImportUrl(source);

  return credential || !url || url.protocol !== "https:" || SECRET_IN_SOURCE.test(source);
}

/** Also protect response metadata if an older worker missed a credential URL. */
export function displayImportUrl(value: string): string {
  return inspectImportUrl(value).credential ? "[redacted]" : value;
}

export function marketplaceCandidates(
  items: readonly ImportLibraryItem[],
  context: LibraryContext,
  live: ReadonlySet<string>,
): ui.ImportLibraryCandidate[] {
  const groups = grouped(
    items.filter((i) => i.kind === "marketplace"),
    (i) => (i.source ? marketplaceSource(i.source) : `${i.agentCli}:${i.name}`),
  );

  return groups.map((group) => {
    const item = group[0]!;
    const common = { ...base(group), detail: displayImportUrl(item.source || item.detail) };

    if (item.reason)
      return create(ui.ImportLibraryCandidateSchema, { ...common, status: "unavailable", reason: item.reason });

    // Fail closed whatever the worker checked: a source with user info or masked parts is never stored in a plan.
    if (group.some((i) => unsafeMarketplaceSource(i.source) || (i.value && unsafeMarketplaceSource(i.value))))
      return create(ui.ImportLibraryCandidateSchema, { ...common, status: "unavailable", reason: SOURCE_CREDENTIAL });

    if (group.some((i) => live.has(liveKey(i))))
      return create(ui.ImportLibraryCandidateSchema, { ...common, status: "imported" });
    const source = marketplaceSource(item.source);

    if (context.marketplaces.some((m) => m.source && marketplaceSource(m.source.url) === source))
      return create(ui.ImportLibraryCandidateSchema, { ...common, status: "same" });

    return create(ui.ImportLibraryCandidateSchema, {
      ...common,
      status: "new",
      proposed: "New marketplace in Agent environment",
      suggested: true,
    });
  });
}

/** Plugins: listed with their version and what to do; an import never activates code. */
export function pluginCandidates(items: readonly ImportLibraryItem[]): ui.ImportLibraryCandidate[] {
  return grouped(
    items.filter((i) => i.kind === "plugin"),
    (i) => i.name,
  ).map((group) =>
    create(ui.ImportLibraryCandidateSchema, {
      ...base(group),
      detail: group[0]!.version,
      status: "unavailable",
      reason: group[0]!.reason,
    }),
  );
}

/**
 * MCP servers as connector account drafts (docs/import.md, "Serwery MCP"): one per server, with its secret slots.
 * An account with the same endpoint is *Same in Canopy*. A new one has no access until the owner grants it.
 */
export function connectorCandidates(
  items: readonly ImportLibraryItem[],
  context: LibraryContext,
  live: ReadonlySet<string>,
): ui.ImportLibraryCandidate[] {
  return items.flatMap((item) => (item.kind === "connector" ? [connectorCandidate(item, context, live)] : []));
}

export function unsafeConnectorUrl(value: string): boolean {
  const { url, credential } = inspectImportUrl(value);

  return (
    credential || !url || !["http:", "https:"].includes(url.protocol) || !!url.search || SECRET_IN_SOURCE.test(value)
  );
}

function connectorCandidate(
  item: ImportLibraryItem,
  context: LibraryContext,
  live: ReadonlySet<string>,
): ui.ImportLibraryCandidate {
  const common = {
    ...base([item]),
    name: importName(item.name.normalize("NFC"), 80),
    detail: displayImportUrl(item.detail),
    transport: item.transport,
    slots: [...item.slots],
  };

  if (item.reason)
    return create(ui.ImportLibraryCandidateSchema, { ...common, status: "unavailable", reason: item.reason });

  // Fail closed whatever the worker checked: a URL with user info or masked parts never becomes an account.
  if (unsafeConnectorUrl(item.detail) || SECRET_IN_SOURCE.test(item.value))
    return create(ui.ImportLibraryCandidateSchema, {
      ...common,
      status: "unavailable",
      reason: "Its URL may hold a secret (user, password or query). Add it in Connectors.",
    });

  if (live.has(liveKey(item))) return create(ui.ImportLibraryCandidateSchema, { ...common, status: "imported" });

  if (context.connectors.some((a) => a.connectorType === "custom" && a.url === item.detail))
    return create(ui.ImportLibraryCandidateSchema, { ...common, status: "same" });

  return create(ui.ImportLibraryCandidateSchema, {
    ...common,
    status: "new",
    proposed: "New connected account, with no access yet",
    suggested: true,
  });
}
