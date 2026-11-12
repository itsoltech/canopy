import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { heapGraph } from "./diagnostics-heap-graph.ts";

test("heap evidence excludes weak-only objects and redacts payload strings and dynamic constructor names", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canopy-retention-report-"));
  const file = join(directory, "snapshot.json");
  const secret = "private-query-parameter-and-error-message";

  try {
    await Bun.write(
      file,
      JSON.stringify({
        snapshot: {
          meta: {
            node_fields: ["type", "name", "id", "self_size", "edge_count"],
            node_types: [["synthetic", "object", "string"], "string", "number", "number", "number"],
            edge_fields: ["type", "name_or_index", "to_node"],
            edge_types: [["internal", "property", "weak"], "string_or_number", "node"],
          },
        },
        strings: ["", "Query", "parameters", secret],
        nodes: [0, 0, 1, 0, 2, 1, 1, 3, 32, 1, 2, 3, 5, 1024, 0, 1, 3, 7, 2048, 0],
        edges: [0, 0, 5, 2, 0, 15, 1, 2, 10],
      }),
    );
    const graph = await heapGraph(file);
    expect(graph.path(2).complete).toBe(true);
    expect(graph.path(2).fromRoot.map((part) => part.constructor)).toEqual(["Query", "string"]);
    expect(graph.path(2).fromRoot.at(-1)?.via).toBe("parameters");
    expect(graph.parents[3]).toBe(-1);
    expect(JSON.stringify(graph.path(2))).not.toContain(secret);
    expect(graph.label(3)).toStartWith("redacted:");
    expect(graph.label(3)).not.toContain(secret);

    await Bun.write(file, JSON.stringify({ invalid: secret }));

    const error = await heapGraph(file).then(
      () => "unexpected success",
      (failure: Error) => failure.message,
    );

    expect(error).toBe("Cannot read a supported V8 heap snapshot");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
