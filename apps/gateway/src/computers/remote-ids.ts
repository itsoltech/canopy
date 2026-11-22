import { ScalarType, type DescMessage, type Message } from "@bufbuild/protobuf";

import { isReflectMessage, reflect } from "@bufbuild/protobuf/reflect";

import { MentionKind } from "@canopy/contracts";

import { isEntityId, nodeRef, qualifyId, splitId } from "@canopy/domain/computers";

import { Code, ConnectError } from "@connectrpc/connect";

// ------------------------------------------------------------------ ids

export const idField = (name: string) =>
  !["global_id", "snapshot_id", "preparation_request_id", "sandbox_profile_id"].includes(name) &&
  (name === "id" || name.endsWith("_id") || name.endsWith("_ids"));

/** Catalog profiles and installation attempts keep their original IDs across linked calls. */
const opaqueId = (desc: DescMessage, message: Message, name: string) =>
  (name === "id" && desc.typeName === "canopy.worker.v1.SandboxProfile") ||
  (name === "install_id" &&
    [
      "canopy.ui.v1.InstallCliRequest",
      "canopy.worker.v1.CliInstallStatus",
      "canopy.worker.v1.CliInstallProgress",
    ].includes(desc.typeName)) ||
  (name === "request_id" &&
    desc.typeName === "canopy.ui.v1.UpdateStep" &&
    reflect(desc, message).get(desc.field["kind"]!) === "cli");

export const STAMPED = new Set([
  "canopy.ui.v1.Thread",
  "canopy.ui.v1.Worker",
  "canopy.ui.v1.Project",
  "canopy.ui.v1.Bot",
]);

/** Rewrites every id-like string field (`id`, `*_id`, `*_ids`) of a message in place, recursively. */
export function mapIds(
  desc: DescMessage,
  message: Message,
  mapField: (id: string, field: string, desc: DescMessage, message: Message) => string,
  visit?: (desc: DescMessage, message: Message) => void,
): void {
  const record = reflect(desc, message);
  const map = (id: string, field: string) => mapField(id, field, desc, message);
  visit?.(desc, message);

  // Preview and OS target identifiers are opaque live-session selectors, never Canopy entities.
  if (["canopy.worker.v1.AgentPreviewEvent", "canopy.worker.v1.AgentPreviewTarget"].includes(desc.typeName)) return;

  if (["canopy.ui.v1.SendAgentPreviewInputRequest", "canopy.ui.v1.AckAgentPreviewRequest"].includes(desc.typeName)) {
    const field = desc.field["threadId"]!;
    record.set(field, map(String(record.get(field)), "thread_id"));

    return;
  }

  // Activity IDs and OS selectors are opaque; only its Canopy scope is routed.
  if (desc.typeName === "canopy.ui.v1.ThreadAutomationActivity") {
    for (const name of ["turnId", "workerId"]) {
      const field = desc.field[name]!;
      const value = String(record.get(field));

      if (value) record.set(field, map(value, field.name));
    }

    return;
  }

  // OS window/device identifiers are opaque selectors, even when a simulator UDID is a UUID.
  // Only a copied, qualified Canopy thread session participates in home routing.
  if (desc.typeName === "canopy.worker.v1.RunAgentTool") {
    const field = desc.field["session"]!;
    const session = String(record.get(field));

    if (isEntityId(session) && splitId(session).node) record.set(field, map(session, "thread_id"));

    return;
  }

  if (desc.typeName === "canopy.ui.v1.ThreadSyncRecord") {
    const field = desc.field["key"]!;
    const key = String(record.get(field));
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator).replace(/^legacy_/, "");

    if (["thread", "turn", "item", "interaction", "steer", "delivery", "goal"].includes(kind))
      record.set(field, `${key.slice(0, separator + 1)}${map(key.slice(separator + 1), `${kind}_id`)}`);
  }

  if (
    desc.typeName === "canopy.worker.v1.Mention" &&
    [MentionKind.BOT, MentionKind.THREAD, MentionKind.CONNECTOR, MentionKind.ATTACHMENT].some(
      (kind) => kind === record.get(desc.field["kind"]!),
    )
  ) {
    const name = desc.field["name"]!;
    record.set(name, map(String(record.get(name)), "mention_id"));
  }

  for (const field of desc.fields) {
    if (field.oneof && record.oneofCase(field.oneof) !== field) continue;

    if (opaqueId(desc, message, field.name)) continue;

    if (field.fieldKind === "scalar" && field.scalar === ScalarType.STRING && idField(field.name)) {
      const value = record.get(field);

      if (value) record.set(field, map(value, field.name));
    } else if (
      field.fieldKind === "list" &&
      field.listKind === "scalar" &&
      field.scalar === ScalarType.STRING &&
      idField(field.name)
    ) {
      const values = record.get(field);

      for (const [index, value] of values.entries()) {
        // SAFETY: The descriptor identifies this list as scalar STRING, so every reflected element is a string.
        values.set(index, map(value as string, field.name));
      }
    } else if (field.fieldKind === "list" && field.listKind === "message") {
      for (const item of record.get(field))
        if (isReflectMessage(item)) mapIds(field.message, item.message, mapField, visit);
    } else if (field.fieldKind === "message" && record.isSet(field))
      mapIds(field.message, record.get(field).message, mapField, visit);
    else if (field.fieldKind === "map" && field.mapKind === "message")
      for (const item of record.get(field).values())
        if (isReflectMessage(item)) mapIds(field.message, item.message, mapField, visit);
  }
}

/** Ids from the home become unambiguous here; threads, workers and projects say which computer they live on. */
export function qualify(desc: DescMessage, message: Message, nodeId: string): void {
  mapIds(
    desc,
    message,
    (id, field) => (field === "proxy_id" ? id : qualifyId(id, nodeId)),
    (d, message) => {
      if (STAMPED.has(d.typeName)) reflect(d, message).set(d.field["nodeId"]!, nodeId);
    },
  );
}

/** The computers a request's ids point at (empty: all local). */
export function nodesOf(desc: DescMessage, message: Message, topLevelOnly = false): Set<string> {
  const nodes = new Set<string>();

  if (topLevelOnly) {
    const record = reflect(desc, message);

    for (const field of desc.fields) {
      if (opaqueId(desc, message, field.name)) continue;

      if (field.fieldKind === "scalar" && field.scalar === ScalarType.STRING && idField(field.name)) {
        const { node } = splitId(record.get(field));

        if (node) nodes.add(node);
      }
    }

    return nodes;
  }

  mapIds(desc, message, (id) => {
    const { node } = splitId(id);

    if (node) nodes.add(node);

    return id;
  });

  return nodes;
}

/**
 * A request for the home: its own ids, nothing of this or any third computer (no transitive sharing yet).
 * `global`: ids that are the same on every computer (shared projects, stage 4) pass unchanged.
 */
export function unqualify(
  desc: DescMessage,
  message: Message,
  nodeId: string,
  global: ReadonlySet<string> = new Set(),
): void {
  mapIds(desc, message, (id, field) => {
    const { id: plain, node } = splitId(id);

    if (node === nodeRef(nodeId)) return plain;

    if (!node && (field === "project_id" || field === "project_ids" || field === "proxy_id") && global.has(id))
      return id;

    if (node || (field !== "client_request_id" && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)))
      throw new ConnectError("Choose a project, worker and thread on the same computer", Code.InvalidArgument);

    return id;
  });
}
