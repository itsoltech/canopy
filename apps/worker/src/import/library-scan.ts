import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ImportLibraryItemSchema, ImportSecretSlot } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { decodeJsonObject } from "../providers/json.ts";
import { leftOut, SETTINGS } from "./library-settings.ts";
import { maskText, type Masker } from "./masking.ts";
import { readSourceText } from "./read.ts";
import { signSourceKey, type AgentCli, type ImportRootPath } from "./source-key.ts";

/**
 * Settings and library of a CLI home (docs/import.md, "Ustawienia i biblioteka"): metadata only. Items name fixed
 * places in the home (LIBRARY_PLACES); their content is read later, when an import asks for it. Logins, memory and
 * the parts of settings files that run commands are listed with the reason they stay out.
 */

export type LibraryItemInit = MessageInitShape<typeof ImportLibraryItemSchema>;

/** One item before it is tied to its root. */
export interface ItemFields {
  readonly kind: string;
  readonly name: string;
  readonly value?: string;
  readonly detail?: string;
  readonly digest?: string;
  readonly bytes?: bigint;
  readonly reason?: string;
  readonly warnings?: string[];
  readonly files?: number;
  readonly source?: string;
  readonly version?: string;
  readonly transport?: string;
  readonly slots?: ImportSecretSlot[];
}

export type MakeItem = (rel: string, fields: ItemFields) => LibraryItemInit;

/**
 * Every text of an item masked with the one entry point (masking.ts) before it leaves the worker: names, values,
 * details and reasons can hold what a CLI file holds, a URL with credentials too, also for items that are not
 * imported. Digests are taken from the file before this.
 */
export function maskedFields(fields: ItemFields, masker: Masker): ItemFields {
  const masked = (text: string) => maskText(text, masker);

  return {
    ...fields,
    name: masked(fields.name),
    ...(fields.value !== undefined && { value: masked(fields.value) }),
    ...(fields.detail !== undefined && { detail: masked(fields.detail) }),
    ...(fields.reason !== undefined && { reason: masked(fields.reason) }),
    ...(fields.warnings && { warnings: fields.warnings.map(masked) }),
    ...(fields.source !== undefined && { source: masked(fields.source) }),
    ...(fields.version !== undefined && { version: masked(fields.version) }),
    ...(fields.transport !== undefined && { transport: masked(fields.transport) }),
    ...(fields.slots && {
      slots: fields.slots.map((slot) => ({
        ...slot,
        name: masked(slot.name),
        kind: masked(slot.kind),
        variable: masked(slot.variable),
      })),
    }),
  };
}

/** Instructions longer than this do not fit Canopy's instruction documents. */
export const INSTRUCTION_BYTES = 24 * 1024;
const CONFIG_BYTES = 1024 ** 2;

interface Place {
  readonly settings: string;
  readonly instructions: readonly string[];
  readonly login: readonly string[];
  readonly memory: (root: string) => boolean;
}

export const LIBRARY_PLACES: Readonly<Record<AgentCli, Place>> = {
  claude: {
    settings: "settings.json",
    instructions: ["CLAUDE.md"],
    login: [".credentials.json"],
    memory: (root) => projectMemory(join(root, "projects")),
  },
  codex: {
    settings: "config.toml",
    // Codex reads AGENTS.override.md instead of AGENTS.md when both exist.
    instructions: ["AGENTS.override.md", "AGENTS.md"],
    login: ["auth.json"],
    memory: (root) => existsSync(join(root, "memories_1.sqlite")),
  },
  grok: {
    settings: "config.toml",
    instructions: ["AGENTS.md"],
    login: ["auth.json"],
    memory: (root) => existsSync(join(root, "memory")),
  },
};

/** Where a library key may point in a root of this CLI: a file, a skill directory, or nothing. */
export function libraryPlace(cli: AgentCli, rel: string): "file" | "skill" | "command" | "mcp" | undefined {
  const place = LIBRARY_PLACES[cli];

  if (cli === "claude" && /^\.claude\.json#mcp\/[A-Za-z0-9_-]+$/.test(rel)) return "mcp";

  if (cli === "codex" && /^config\.toml#mcp\/[A-Za-z0-9_-]+$/.test(rel)) return "mcp";

  if (place.instructions.includes(rel)) return "file";

  if (/^skills\/[^/]+$/.test(rel)) return "skill";

  if (cli === "claude" && /^commands\/(?:[^/]+\/)*[^/]+\.md$/i.test(rel)) return "command";

  if (cli === "codex" && /^prompts\/[^/]+\.md$/i.test(rel)) return "command";

  return undefined;
}

/** Makes items of one root: each with a signed key to `rel`, or to `<settings>#<name>` for what is no file. */
export function itemMaker(root: ImportRootPath, key: Buffer, masker: Masker): MakeItem {
  const settings = LIBRARY_PLACES[root.agentCli].settings;

  return (rel, fields) => ({
    // A setting names its file and itself (`settings.json#model`): one key per item, never readable as a file.
    sourceKey: signSourceKey(key, root, join(root.path, rel || `${settings}#${fields.name}`)),
    agentCli: root.agentCli,
    rootId: root.id,
    ...maskedFields(fields, masker),
  });
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function scanLibrary(root: ImportRootPath, key: Buffer, masker: Masker): LibraryItemInit[] {
  const place = LIBRARY_PLACES[root.agentCli];
  const items: LibraryItemInit[] = [];
  const item = itemMaker(root, key, masker);

  const config = readConfig(root, place.settings);

  if (config) {
    for (const fact of SETTINGS[root.agentCli](config)) {
      items.push(
        item(`${place.settings}#${fact.name}`, {
          kind: "setting",
          name: fact.name,
          value: fact.value,
          detail: fact.detail,
          digest: sha256(fact.value),
          reason: fact.reason,
        }),
      );
    }

    for (const out of leftOut(root.agentCli, config))
      items.push(item("", { kind: "setting", name: out.name, reason: out.reason }));
  }

  items.push(...instructions(root, place, masker, item));

  if (place.login.some((name) => existsSync(join(root.path, name))))
    items.push(
      item("", { kind: "setting", name: "Login", reason: "Canopy uses the login of each provider instance." }),
    );

  if (place.memory(root.path))
    items.push(item("", { kind: "setting", name: "Memory", reason: "CLI memory stays out of Canopy threads." }));

  return items;
}

function instructions(root: ImportRootPath, place: Place, masker: Masker, item: MakeItem): LibraryItemInit[] {
  const found = place.instructions.flatMap((name) => {
    const text = readText(root, name, INSTRUCTION_BYTES * 4);

    return text === undefined ? [] : [{ name, text }];
  });

  return found.map(({ name, text }, index) => {
    const bytes = Buffer.byteLength(text);
    const warnings = /^@\S+/m.test(text) ? ["Canopy doesn't follow @ imports in this file."] : [];
    let secrets = 0;
    maskText(text, masker, () => (secrets += 1));

    if (secrets > 0)
      warnings.push(`Canopy masks ${secrets} possible ${secrets === 1 ? "secret" : "secrets"} in this file.`);
    let reason = "";

    if (index > 0) reason = `${found[0]!.name} takes its place in this CLI.`;
    else if (root.agentCli === "grok") reason = "Canopy instructions cover Claude and Codex for now.";
    else if (bytes > INSTRUCTION_BYTES) reason = "The file is longer than 24 KiB, the limit for Canopy instructions.";
    else if (!text.trim()) reason = "The file is empty.";

    return item(name, {
      kind: "instruction",
      name,
      detail: name,
      digest: sha256(text),
      bytes: BigInt(bytes),
      reason,
      warnings,
    });
  });
}

/** A small file at a fixed place of the root, read without following links; undefined when absent or unreadable. */
export function readText(root: ImportRootPath, rel: string, max: number): string | undefined {
  return readSourceText({ root: root.path, path: join(root.path, rel) }, max);
}

export function readConfig(root: ImportRootPath, rel: string): JsonObject | undefined {
  const text = readText(root, rel, CONFIG_BYTES);

  if (text === undefined) return undefined;

  try {
    return decodeJsonObject(rel.endsWith(".toml") ? Bun.TOML.parse(text) : JSON.parse(text));
  } catch {
    return undefined;
  }
}

function projectMemory(projects: string): boolean {
  try {
    return readdirSync(projects).some((dir) => existsSync(join(projects, dir, "memory")));
  } catch {
    return false;
  }
}
