import { clone, toJson } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { checkDocument, compose, foreignWorkers, uuid } from "./composition.ts";
import { audit, documents, saveDocument, workers } from "./database.ts";

export const checked = <A>(perform: () => A) =>
  Effect.try({
    try: perform,
    catch: (error) =>
      error instanceof ConnectError
        ? error
        : new ConnectError("Invalid environment configuration.", Code.InvalidArgument),
  });

export function putDocument(sql: SqlClient.SqlClient, owner: string, next: bigint, document: ui.InstructionDocument) {
  return Effect.gen(function* () {
    const library = yield* documents(sql, owner);
    const machines = yield* workers(sql, owner);
    const previous = library.find((d) => d.id === document.id);

    const foreign = foreignWorkers(
      [previous?.selector, ...(previous?.fragments ?? []).map((f) => f.selector)],
      machines,
    );

    yield* checked(() => checkDocument(document, machines, foreign));

    if (document.id && !previous) return yield* Effect.fail(new ConnectError("Document not found.", Code.NotFound));

    if (!previous && library.length >= 100)
      return yield* Effect.fail(
        new ConnectError("The library can contain at most 100 documents.", Code.InvalidArgument),
      );
    const saved = clone(ui.InstructionDocumentSchema, document);
    saved.id ||= Bun.randomUUIDv7();
    saved.revision = next;
    const updated = previous ? library.map((d) => (d.id === saved.id ? saved : d)) : [...library, saved];
    yield* checked(() => {
      for (const machine of machines) compose(updated, machine);
    });
    yield* saveDocument(sql, owner, saved);
    yield* audit(sql, owner, "environment.document.save", saved.id);
  });
}

export function removeDocument(sql: SqlClient.SqlClient, owner: string, next: bigint, id: string) {
  return Effect.gen(function* () {
    if (!uuid(id)) return yield* Effect.fail(new ConnectError("Document not found.", Code.NotFound));
    const library = yield* documents(sql, owner);
    const doc = library.find((d) => d.id === id);

    if (!doc) return yield* Effect.fail(new ConnectError("Document not found.", Code.NotFound));
    const json = JSON.stringify(toJson(ui.InstructionDocumentSchema, doc));
    yield* sql`INSERT INTO instruction_document_versions (document_id, owner_user_id, revision, document, deleted)
      VALUES (${id}::uuid, ${owner}::uuid, ${next}, ${json}::jsonb, true)`;
    yield* sql`DELETE FROM instruction_documents WHERE id = ${id}::uuid AND owner_user_id = ${owner}::uuid`;
    yield* audit(sql, owner, "environment.document.delete", id);
  });
}

export function setTags(sql: SqlClient.SqlClient, owner: string, id: string, tags: string[]) {
  return Effect.gen(function* () {
    const machines = yield* workers(sql, owner);
    const machine = machines.find((w) => w.workerId === id);

    if (!machine) return yield* Effect.fail(new ConnectError("Worker not found.", Code.NotFound));
    machine.manualTags = tags;
    const library = yield* documents(sql, owner);
    yield* checked(() => compose(library, machine));
    yield* sql`INSERT INTO worker_environments (worker_id, manual_tags) VALUES (${id}::uuid, ${tags}::text[])
      ON CONFLICT (worker_id) DO UPDATE SET manual_tags = EXCLUDED.manual_tags`;
    yield* audit(sql, owner, "environment.tags.save", id);
  });
}
