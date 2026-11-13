import { heapGraph, type HeapGraph } from "./diagnostics-heap-graph.ts";

interface Total {
  count: number;
  selfBytes: number;
}

function summarize(graph: HeapGraph) {
  const types = new Map<string, Total>();
  const strings: number[] = [];
  const objects: number[] = [];

  for (let index = 0; index < graph.count; index++) {
    if (graph.parents[index] === -1) continue;
    const label = graph.label(index);
    const selfBytes = graph.number(index, graph.nodeSize);
    const total = types.get(label) ?? { count: 0, selfBytes: 0 };
    total.count++;
    total.selfBytes += selfBytes;
    types.set(label, total);
    const kind = graph.kind(index);
    const largest = kind.includes("string") ? strings : objects;
    largest.push(index);
    largest.sort((left, right) => graph.number(right, graph.nodeSize) - graph.number(left, graph.nodeSize));

    if (largest.length > 20) largest.pop();
  }

  const row = (index: number) => ({
    id: graph.number(index, graph.nodeId),
    constructor: graph.label(index),
    selfBytes: graph.number(index, graph.nodeSize),
    path: graph.path(index),
  });

  return { format: graph.format, types, largestStrings: strings.map(row), largestObjects: objects.map(row) };
}

const [off, on] = Bun.argv.slice(2);

if (!off || !on) throw new Error("Usage: bun scripts/bench/diagnostics-heap-report.ts off.json on.json");

// Analyze sequentially; do not hold both snapshot graphs in memory.
const a = summarize(await heapGraph(off));

Bun.gc(true);

const b = summarize(await heapGraph(on));

const deltas = [...new Set([...a.types.keys(), ...b.types.keys()])].map((constructor) => {
  const before = a.types.get(constructor) ?? { count: 0, selfBytes: 0 };
  const after = b.types.get(constructor) ?? { count: 0, selfBytes: 0 };

  return {
    constructor,
    off: before,
    on: after,
    deltaCount: after.count - before.count,
    deltaSelfBytes: after.selfBytes - before.selfBytes,
  };
});

deltas.sort((left, right) => right.deltaSelfBytes - left.deltaSelfBytes);

console.info(
  JSON.stringify(
    {
      sizes:
        "Root-reachable self bytes, not dominator retained sizes. V8 weak edges excluded; JSC has no weak-edge classification. Paths capped at 100 edges.",
      privacy: "No string contents, error messages, dynamic property keys or closure names are emitted.",
      types: deltas,
      off: { format: a.format, largestStrings: a.largestStrings, largestObjects: a.largestObjects },
      on: { format: b.format, largestStrings: b.largestStrings, largestObjects: b.largestObjects },
    },
    null,
    2,
  ),
);
