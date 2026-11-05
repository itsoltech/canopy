import { ScalarType, type DescMessage, type Message } from "@bufbuild/protobuf";

import { isReflectMessage, reflect } from "@bufbuild/protobuf/reflect";

import { MentionKind } from "@canopy/contracts";

import { nodeRef, qualifyId, splitId } from "@canopy/domain/computers";

import { Code, ConnectError } from "@connectrpc/connect";

// ------------------------------------------------------------------ ids

export const idField = (name: string) =>
  name !== "global_id" && (name === "id" || name.endsWith("_id") || name.endsWith("_ids"));

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
  map: (id: string, field: string) => string,
  visit?: (desc: DescMessage, message: Message) => void,
): void {
  const record = reflect(desc, message);
  visit?.(desc, message);

  if (
    desc.typeName === "canopy.worker.v1.Mention" &&
    [MentionKind.BOT, MentionKind.THREAD, MentionKind.CONNECTOR].some(
      (kind) => kind === record.get(desc.field["kind"]!),
    )
  ) {
    const name = desc.field["name"]!;
    record.set(name, map(String(record.get(name)), "mention_id"));
  }

  for (const field of desc.fields) {
    if (field.oneof && record.oneofCase(field.oneof) !== field) continue;

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
      for (const item of record.get(field)) if (isReflectMessage(item)) mapIds(field.message, item.message, map, visit);
    } else if (field.fieldKind === "message" && record.isSet(field))
      mapIds(field.message, record.get(field).message, map, visit);
    else if (field.fieldKind === "map" && field.mapKind === "message")
      for (const item of record.get(field).values())
        if (isReflectMessage(item)) mapIds(field.message, item.message, map, visit);
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
