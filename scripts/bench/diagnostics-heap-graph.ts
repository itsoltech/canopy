import { Schema } from "effect";
import { createHash } from "node:crypto";
import { JscSnapshot, normalizeJsc } from "./diagnostics-heap-jsc.ts";

const Snapshot = Schema.Struct({
  snapshot: Schema.Struct({
    meta: Schema.Struct({
      node_fields: Schema.Array(Schema.String),
      node_types: Schema.Array(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
      edge_fields: Schema.Array(Schema.String),
      edge_types: Schema.Array(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    }),
  }),
  nodes: Schema.Array(Schema.Number),
  edges: Schema.Array(Schema.Number),
  strings: Schema.Array(Schema.String),
});

const CONSTRUCTORS = new Set([
  "Object",
  "Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "Error",
  "TypeError",
  "RangeError",
  "Function",
  "String",
  "Date",
  "ArrayBuffer",
  "Uint8Array",
  "Float64Array",
  "Int32Array",
  "Buffer",
  "Query",
  "Connection",
  "PgConnection",
  "PgPool",
  "SqlError",
  "ConnectionError",
  "UnknownError",
  "DatabaseMonitor",
  "DatabaseConnection",
  "ObservedConnection",
  "DatabaseMeasurements",
  "DiagnosticsPersistence",
  "DiagnosticsStore",
  "ProcessGovernor",
  "ProcessDiagnostics",
  "RpcCollector",
  "WorkerDiagnostics",
  "WorkerMeasurements",
  "WorkerTurns",
  "Measure",
  "Histogram",
  "Scope",
  "Fiber",
  "FiberImpl",
  "ModuleRecord",
  "FunctionExecutable",
  "UnlinkedFunctionExecutable",
  "FunctionCodeBlock",
  "UnlinkedFunctionCodeBlock",
  "Structure",
  "PropertyTable",
  "LexicalEnvironment",
  "AsyncGenerator",
  "Generator",
  "SlimPromiseReaction",
  "FullPromiseReaction",
  "QueryMachine",
  "PgConnectionImpl",
  "JSLexicalEnvironment",
  "JSModuleEnvironment",
  "JSSourceCode",
  "JSGlobalLexicalEnvironment",
  "ModuleProgramExecutable",
  "UnlinkedModuleProgramCodeBlock",
  "GlobalObject",
  "JSGlobalProxy",
  "SymbolTable",
]);

const FIELDS = new Set([
  "parameters",
  "params",
  "query",
  "detail",
  "cause",
  "message",
  "stack",
  "error",
  "errors",
  "reason",
  "reasons",
  "value",
  "values",
  "pending",
  "payload",
  "minutes",
  "collector",
  "monitor",
  "connection",
  "runtime",
  "store",
  "host",
  "work",
  "exit",
  "result",
  "operation",
  "resolve",
  "reject",
  "this",
]);

/** Stable grouping without disclosing dynamic constructor names or string contents. */
export function constructorLabel(name: string) {
  return CONSTRUCTORS.has(name) ? name : `redacted:${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}

export async function heapGraph(file: string) {
  try {
    const data = Schema.decodeUnknownSync(Schema.Union([Snapshot, JscSnapshot]))(await Bun.file(file).json());

    return "nodeClassNames" in data ? new HeapGraph(normalizeJsc(data), "jsc") : new HeapGraph(data, "v8");
  } catch {
    // Schema errors can embed input values. Never print them or preserve them as causes.
    throw new Error("Cannot read a supported heap snapshot");
  }
}

/** One shortest strong retaining path, excluding weak edges; sizes are self bytes, not dominator sizes. */
export class HeapGraph {
  readonly nodeStride: number;
  readonly edgeStride: number;
  readonly count: number;
  readonly nodeType: number;
  readonly nodeName: number;
  readonly nodeId: number;
  readonly nodeSize: number;
  readonly nodeEdges: number;
  readonly edgeType: number;
  readonly edgeName: number;
  readonly edgeTo: number;
  readonly nodeTypes: readonly string[];
  readonly edgeTypes: readonly string[];
  readonly first: Uint32Array;
  readonly parents: Int32Array;
  readonly parentEdges: Int32Array;
  readonly #labels = new Map<number, string>();

  constructor(
    readonly data: typeof Snapshot.Type,
    readonly format: "jsc" | "v8",
  ) {
    const meta = data.snapshot.meta;
    this.nodeStride = meta.node_fields.length;
    this.edgeStride = meta.edge_fields.length;
    this.nodeType = meta.node_fields.indexOf("type");
    this.nodeName = meta.node_fields.indexOf("name");
    this.nodeId = meta.node_fields.indexOf("id");
    this.nodeSize = meta.node_fields.indexOf("self_size");
    this.nodeEdges = meta.node_fields.indexOf("edge_count");
    this.edgeType = meta.edge_fields.indexOf("type");
    this.edgeName = meta.edge_fields.indexOf("name_or_index");
    this.edgeTo = meta.edge_fields.indexOf("to_node");

    if (
      [
        this.nodeType,
        this.nodeName,
        this.nodeId,
        this.nodeSize,
        this.nodeEdges,
        this.edgeType,
        this.edgeName,
        this.edgeTo,
      ].some((field) => field < 0) ||
      !this.nodeStride ||
      !this.edgeStride ||
      data.nodes.length % this.nodeStride ||
      data.edges.length % this.edgeStride
    )
      throw new Error("Unsupported heap metadata");
    this.nodeTypes = Schema.decodeUnknownSync(Schema.Array(Schema.String))(meta.node_types[this.nodeType]);
    this.edgeTypes = Schema.decodeUnknownSync(Schema.Array(Schema.String))(meta.edge_types[this.edgeType]);
    this.count = data.nodes.length / this.nodeStride;
    this.first = new Uint32Array(this.count + 1);
    this.parents = new Int32Array(this.count).fill(-1);
    this.parentEdges = new Int32Array(this.count).fill(-1);
    let edge = 0;

    for (let index = 0; index < this.count; index++) {
      this.first[index] = edge;
      edge += this.number(index, this.nodeEdges) * this.edgeStride;
    }

    if (!this.count || edge !== data.edges.length) throw new Error("Invalid heap adjacency");
    this.first[this.count] = edge;
    this.#paths();
  }

  number(index: number, field: number) {
    const value = this.data.nodes[index * this.nodeStride + field];

    if (value === undefined || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid heap node");

    return value;
  }

  kind(index: number) {
    return this.nodeTypes[this.number(index, this.nodeType)] ?? "unknown";
  }

  label(index: number) {
    const kind = this.kind(index);

    // String/closure names may be application text. Only object constructor names are classified.
    if (kind !== "object") return kind;
    const name = this.number(index, this.nodeName);
    let label = this.#labels.get(name);

    if (!label) {
      label = constructorLabel(this.data.strings[name] ?? "");
      this.#labels.set(name, label);
    }

    return label;
  }

  #paths() {
    const queue = new Uint32Array(this.count);
    let tail = 1;
    this.parents[0] = 0;

    for (let head = 0; head < tail; head++) {
      const index = queue[head]!;

      for (let edge = this.first[index]!; edge < this.first[index + 1]!; edge += this.edgeStride) {
        const type = this.edgeTypes[this.data.edges[edge + this.edgeType]!];

        if (type === "weak") continue;
        const target = this.data.edges[edge + this.edgeTo]! / this.nodeStride;

        if (!Number.isInteger(target) || target < 0 || target >= this.count) throw new Error("Invalid heap edge");

        if (this.parents[target] !== -1) continue;
        this.parents[target] = index;
        this.parentEdges[target] = edge;
        queue[tail++] = target;
      }
    }
  }

  path(index: number) {
    const path: { via: string; constructor: string; id: number }[] = [];

    for (let steps = 0; index && steps < 100; steps++) {
      const edge = this.parentEdges[index]!;

      if (edge < 0) break;
      const type = this.edgeTypes[this.data.edges[edge + this.edgeType]!] ?? "unknown";
      const name = this.data.strings[this.data.edges[edge + this.edgeName]!] ?? "";
      path.push({
        via: FIELDS.has(name) && (type === "property" || type === "context") ? name : `<${type}>`,
        constructor: this.label(index),
        id: this.number(index, this.nodeId),
      });
      index = this.parents[index]!;
    }

    return { complete: index === 0, fromRoot: path.reverse() };
  }
}
