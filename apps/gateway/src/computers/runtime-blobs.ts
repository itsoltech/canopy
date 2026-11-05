import { create } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { BLOB_BYTES, BLOB_CHUNK, localBlob } from "../config-sync/environment-blobs.ts";
import { HASH } from "../config-sync/environment-values.ts";
import { linkedMessage } from "./remote.ts";
import { configAllowed } from "./runtime-config.ts";
import type { Connection } from "./runtime-context.ts";
import type { LinkedComputers } from "./runtime.ts";

/** Library content for a computer this link shares configuration with; nothing else can ask for it. */
export async function* serveConfigBlob(
  host: LinkedComputers,
  node: string,
  connection: Connection,
  request: link.ConfigBlobRequest,
) {
  const peer = await host.store.peer(node);

  if (!configAllowed(host, node, connection) || !peer?.share_config || !peer.peer_share_config)
    throw new ConnectError("Configuration sharing is off", Code.FailedPrecondition);

  if (!HASH.test(request.hash)) throw new ConnectError("Invalid content hash", Code.InvalidArgument);

  const content = await host.store.runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => localBlob(sql, host.store.owner, request.hash)),
  );

  if (!content) throw new ConnectError("Content not found", Code.NotFound);

  for (let offset = 0; offset < content.length || offset === 0; offset += BLOB_CHUNK)
    yield create(link.ConfigBlobChunkSchema, {
      data: content.subarray(offset, offset + BLOB_CHUNK),
      ...(offset === 0 && { size: BigInt(content.length) }),
    });
}

/** Content by hash from a computer in the configuration group; the caller checks the hash. */
export async function fetchConfigBlob(host: LinkedComputers, node: string, hash: string) {
  const chunks: Uint8Array[] = [];
  let size = -1;
  let received = 0;

  for await (const message of host.remote(
    node,
    link.ConfigSyncService.method.getConfigBlob,
    create(link.ConfigBlobRequestSchema, { hash }),
    AbortSignal.timeout(120_000),
  )) {
    const chunk = linkedMessage(link.ConfigBlobChunkSchema, message);

    if (size < 0) size = Number(chunk.size);
    received += chunk.data.length;

    if (size > BLOB_BYTES || received > size) throw new ConnectError("Content too large", Code.ResourceExhausted);
    chunks.push(chunk.data);
  }

  if (received !== size) throw new ConnectError("Content incomplete", Code.DataLoss);

  return Buffer.concat(chunks);
}
