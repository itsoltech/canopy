import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { PermissionMode, Provider } from "@canopy/contracts";
import { eventually, type TestGateway } from "./gateway.ts";

const sql = <A extends object>(gw: TestGateway, text: string, params: unknown[]) =>
  gw.core.computers!.store.query<A>(text, params);

export async function thread(
  gw: TestGateway,
  project: string,
  workspace: string,
  title: string,
  message: string,
  parentThreadId = "",
) {
  const created = (
    await gw.api.createThread({
      projectId: project,
      workspaceId: workspace,
      title,
      provider: Provider.CODEX,
      permissionMode: PermissionMode.ASK,
      initialMessage: message,
      parentThreadId,
      clientRequestId: crypto.randomUUID(),
    })
  ).thread!.id;

  await idle(gw, created);

  return created;
}

/** Every turn of the thread ended. */
export const idle = (gw: TestGateway, threadId: string) =>
  eventually(
    async () =>
      (
        await sql<{ n: number }>(
          gw,
          `SELECT count(*)::int AS n FROM turns WHERE thread_id=$1::uuid AND status IN ('queued','running')`,
          [threadId],
        )
      )[0]!.n +
      (
        await sql<{ n: number }>(
          gw,
          `SELECT count(*)::int AS n FROM threads WHERE id=$1::uuid AND status IN ('creating','running')`,
          [threadId],
        )
      )[0]!.n,
    (n) => n === 0,
    10000,
  );

export async function snapshot(gw: TestGateway, threadId: string) {
  const abort = new AbortController();

  try {
    for await (const u of gw.api.watchThread({ threadId }, { signal: abort.signal }))
      if (u.change.case === "snapshot") return u.change.value;
  } finally {
    abort.abort();
  }

  throw new Error("no snapshot");
}

export async function verifyMovedPreviews(a: TestGateway, c: TestGateway, t: string, startMove: () => Promise<string>) {
  const data = new TextEncoder().encode("verified transcript preview");
  const hash = createHash("sha256").update(data).digest("hex");
  const unverified = createHash("sha256").update("old reference").digest("hex");
  await sql(
    a,
    `INSERT INTO blobs(sha256,size_bytes,mime_type,data)
    VALUES($1,$3,'text/plain',$4), ($2,13,'text/plain',convert_to('old reference','UTF8'))`,
    [hash, unverified, data.length, data],
  );
  await sql(a, "INSERT INTO thread_blobs(thread_id,sha256,verified) VALUES($1::uuid,$2,true),($1::uuid,$3,false)", [
    t,
    hash,
    unverified,
  ]);
  await sql(c, "INSERT INTO blobs(sha256,size_bytes,mime_type,data) VALUES($1,0,'text/plain',decode('','hex'))", [
    hash,
  ]);
  const moveId = await startMove();
  await eventually(
    () => c.api.getMoves({}),
    (v) => v.moves.some((m) => m.id === moveId && m.state === "done"),
  );
  expect(await sql(c, "SELECT sha256,verified FROM thread_blobs WHERE thread_id=$1::uuid", [t])).toEqual([
    { sha256: hash, verified: true },
  ]);
  expect((await c.api.getThreadBlob({ threadId: t, sha256: hash })).data).toEqual(data);
}
