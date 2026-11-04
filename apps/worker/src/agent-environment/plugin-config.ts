import { dirname, join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { EnvironmentSkillStatusSchema, SkillFileSchema, type EnvironmentResolution } from "@canopy/contracts";
import { Schema } from "effect";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { InstructionLedger } from "./ledger.ts";
import { readInstructionFile, replaceInstructionFile, restoreInstructionFile } from "./files.ts";

const BEGIN = "# canopy:plugins:begin";
const END = "# canopy:plugins:end";
const ownKey = (key: string) => key.startsWith("canopy-") || key.includes("@canopy-");
const ObjectSchema = Schema.Record(Schema.String, Schema.MutableJson);

type JsonObject = Record<string, typeof Schema.MutableJson.Type>;

/** Extract only owned namespaces, preserving all unrelated settings and secrets on the device. */
function jsonConfig(text: string, desired: JsonObject, versioned: boolean) {
  const current = { ...Schema.decodeUnknownSync(ObjectSchema)(JSON.parse(text || "{}")) };

  if (versioned) {
    if (current["version"] !== undefined && current["version"] !== 2)
      throw new Error("Unsupported plugin registry version.");
    current["version"] = 2;
  }

  const managed: JsonObject = {};

  for (const field of Object.keys(desired)) {
    const values = Schema.decodeUnknownSync(ObjectSchema)(current[field] ?? {});
    const ours: JsonObject = {};
    const others: JsonObject = {};

    for (const [key, value] of Object.entries(values)) (ownKey(key) ? ours : others)[key] = value;
    managed[field] = ours;
    const next = Schema.decodeUnknownSync(ObjectSchema)(desired[field]);
    current[field] = { ...others, ...next };
  }

  return { managed: JSON.stringify(managed), next: `${JSON.stringify(current, null, 2)}\n` };
}

function tomlConfig(text: string, desired: string) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);

  if (
    start < 0 !== end < 0 ||
    (start >= 0 &&
      (end < start || text.indexOf(BEGIN, start + BEGIN.length) >= 0 || text.indexOf(END, end + END.length) >= 0))
  )
    throw new Error("Invalid Canopy plugin markers. Repair the managed block before syncing.");
  const managed = start < 0 ? "" : text.slice(start + BEGIN.length + 1, end);
  const outside = start < 0 ? text : text.slice(0, start) + text.slice(end + END.length).replace(/^\r?\n/, "");

  const next = desired
    ? `${outside}${outside && !outside.endsWith("\n") ? "\n" : ""}${BEGIN}\n${desired}${END}\n`
    : outside;

  Bun.TOML.parse(next); // Duplicate or conflicting tables fail closed, including outside-block collisions.

  return { managed, next };
}

export interface PluginConfigTarget {
  path: string;
  harness: "claude" | "codex";
  scope: "device" | "platform";
  content: { kind: "toml"; value: string } | { kind: "json"; value: JsonObject };
  active: boolean;
}

/** A launch receipt covers the managed portions, never unrelated device settings. */
export function pluginConfigCheck(target: PluginConfigTarget) {
  return {
    path: target.path,
    kind: target.content.kind,
    fields: target.content.kind === "json" ? Object.keys(target.content.value) : [],
    checksum: environmentDigest(
      target.content.kind === "toml" ? target.content.value : JSON.stringify(target.content.value),
    ),
  };
}

export function observedPluginConfig(check: { path: string; kind: "toml" | "json"; fields: readonly string[] }) {
  const text = readInstructionFile(check.path).text ?? "";

  const managed =
    check.kind === "toml"
      ? tomlConfig(text, "").managed
      : jsonConfig(text, Object.fromEntries(check.fields.map((field) => [field, {}])), false).managed;

  return environmentDigest(managed);
}

export function reconcilePluginConfig(
  target: PluginConfigTarget,
  ledger: InstructionLedger,
  resolution?: EnvironmentResolution,
) {
  const id = environmentDigest(target.path);

  const status = create(EnvironmentSkillStatusSchema, {
    targetId: id,
    harness: target.harness,
    scope: target.scope,
    path: target.path,
    status: "error",
  });

  try {
    if (ledger.problem) throw new Error(ledger.problem);
    const current = readInstructionFile(target.path);

    const rendered =
      target.content.kind === "toml"
        ? tomlConfig(current.text ?? "", target.content.value)
        : jsonConfig(current.text ?? "{}", target.content.value, target.path.endsWith("installed_plugins.json"));

    const expected = target.content.kind === "toml" ? target.content.value : JSON.stringify(target.content.value);

    const empty =
      target.content.kind === "toml"
        ? ""
        : JSON.stringify(Object.fromEntries(Object.keys(target.content.value).map((key) => [key, {}])));

    const previous = ledger.entries.get(id);
    const observed = environmentDigest(rendered.managed);
    const wanted = environmentDigest(expected);
    status.desiredChecksum = wanted;
    status.observedChecksum = current.checksum;
    status.owned = Boolean(previous);
    const conflict = previous ? previous.checksum !== observed : rendered.managed !== empty;
    const force = resolution?.observedChecksum === current.checksum && resolution.desiredChecksum === wanted;
    const kept = previous?.keptDesired === wanted && previous.keptObserved === current.checksum;

    if (
      (kept && !(force && resolution?.action === "overwrite")) ||
      (conflict && force && resolution?.action === "keep")
    ) {
      if (previous) ledger.commit(id, { ...previous, keptDesired: wanted, keptObserved: current.checksum });
      status.status = "kept";
    } else if (conflict && !(force && resolution?.action === "overwrite" && previous)) {
      status.status = "drift";
    } else {
      if (rendered.next !== current.text && (target.active || previous))
        replaceInstructionFile(target.path, current, rendered.next);

      try {
        ledger.commit(
          id,
          target.active
            ? { targetId: id, path: target.path, harness: target.harness, scope: target.scope, checksum: wanted }
            : undefined,
        );
      } catch (error) {
        if (rendered.next !== current.text) restoreInstructionFile(target.path, current, rendered.next);
        throw error;
      }

      status.status = target.active ? "applied" : "removed";
      status.observedChecksum = readInstructionFile(target.path).checksum;
    }

    status.detail = ["drift", "kept"].includes(status.status)
      ? "Managed plugin activation settings changed locally. Compare the local managed block before choosing keep or overwrite."
      : "Managed plugin activation settings synced. Start a new harness session to use them.";

    if (["drift", "kept"].includes(status.status)) {
      status.managedFiles = [
        create(SkillFileSchema, { path: "managed-settings.txt", content: Buffer.from(rendered.managed) }),
      ];
      status.desiredFiles = [create(SkillFileSchema, { path: "managed-settings.txt", content: Buffer.from(expected) })];
    }
  } catch {
    status.detail =
      "Couldn't update plugin activation settings. Check file permissions, syntax and managed markers. Local settings were preserved.";
  }

  return status;
}

export const pluginConfigHome = (path: string) =>
  path.endsWith(join("plugins", "installed_plugins.json")) ? dirname(dirname(path)) : dirname(path);

export const pluginIndexPath = (home: string, harness: string) => join(home, `canopy-${harness}-plugins.json`);
