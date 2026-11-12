import { Schema } from "effect";

export const JscSnapshot = Schema.Struct({
  version: Schema.Int,
  type: Schema.Literal("Inspector"),
  nodes: Schema.Array(Schema.Number),
  nodeClassNames: Schema.Array(Schema.String),
  edges: Schema.Array(Schema.Number),
  edgeTypes: Schema.Array(Schema.String),
  edgeNames: Schema.Array(Schema.String),
});

/** WebKit Inspector v2/v3: four fields per node and edge; IDs are not array offsets. */
export function normalizeJsc(data: typeof JscSnapshot.Type) {
  if (![2, 3].includes(data.version) || data.nodes.length % 4 || data.edges.length % 4 || data.nodes[0] !== 0)
    throw new Error("Unsupported JSC heap metadata");
  const count = data.nodes.length / 4;
  const byId = new Map<number, number>();
  const counts = new Uint32Array(count);

  for (let index = 0; index < count; index++) {
    const id = data.nodes[index * 4]!;

    if (!Number.isSafeInteger(id) || id < 0 || byId.has(id)) throw new Error("Invalid JSC node ID");
    byId.set(id, index);
  }

  for (let edge = 0; edge < data.edges.length; edge += 4) {
    const from = byId.get(data.edges[edge]!);

    if (from === undefined || !byId.has(data.edges[edge + 1]!)) throw new Error("Invalid JSC edge");
    counts[from] = counts[from]! + 1;
  }

  const nodes: number[] = [];
  const positions = new Uint32Array(count);
  let position = 0;

  for (let index = 0; index < count; index++) {
    const name = data.nodes[index * 4 + 2]!;
    const label = data.nodeClassNames[name];

    if (label === undefined) throw new Error("Invalid JSC class");
    nodes.push(
      index === 0 ? 0 : label === "string" || label === "String" ? 2 : 1,
      name,
      data.nodes[index * 4]!,
      data.nodes[index * 4 + 1]!,
      counts[index]!,
    );
    positions[index] = position;
    position += counts[index]! * 3;
  }

  const edges: number[] = Array.from({ length: position }, () => 0);

  for (let edge = 0; edge < data.edges.length; edge += 4) {
    const from = byId.get(data.edges[edge]!)!;
    const to = byId.get(data.edges[edge + 1]!)!;
    const target = positions[from]!;
    const type = data.edgeTypes[data.edges[edge + 2]!];

    if (type === undefined) throw new Error("Invalid JSC edge type");
    edges[target] = data.edges[edge + 2]!;
    // Index edges carry an integer, never an index into the name table.
    edges[target + 1] = type === "Index" ? 0 : data.nodeClassNames.length + data.edges[edge + 3]!;
    edges[target + 2] = to * 5;
    positions[from] = positions[from]! + 3;
  }

  return {
    snapshot: {
      meta: {
        node_fields: ["type", "name", "id", "self_size", "edge_count"],
        node_types: [["synthetic", "object", "string"], "string", "number", "number", "number"],
        edge_fields: ["type", "name_or_index", "to_node"],
        edge_types: [
          data.edgeTypes.map((type) => (type === "Variable" ? "context" : type.toLowerCase())),
          "string_or_number",
          "node",
        ],
      },
    },
    nodes,
    edges,
    strings: [...data.nodeClassNames, ...data.edgeNames],
  };
}
