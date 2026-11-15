import { create, type JsonObject } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { BLOB_PART_BYTES } from "../store/attachments.ts";
import type { ComputerStore } from "./store.ts";

/**
 * A moved attachment before its bytes: the database driver refuses a server message over 16 MiB, so a row never
 * carries a file; sizes are checked first and the bytes read in parts.
 */
export interface MovedFileRow {
  readonly row: JsonObject;
  readonly sha256: string;
  readonly size: number | string;
  readonly mime_type: string;
  readonly thumb_sha256: string | null;
  readonly thumbnail_size: number | string | null;
  readonly thumbnail_mime_type: string | null;
}

/** Columns of `MovedFileRow` over `attachments a JOIN blobs b ON b.sha256 = a.sha256 LEFT JOIN blobs t ON t.sha256 = a.thumb_sha256`. */
export const MOVED_FILE_COLUMNS = `row_to_json(a) AS row, a.sha256, octet_length(b.data) AS size, b.mime_type, a.thumb_sha256,
  octet_length(t.data) AS thumbnail_size, t.mime_type AS thumbnail_mime_type`;

export const movedFilesSize = (files: readonly MovedFileRow[]) =>
  files.reduce((n, f) => n + Number(f.size) + Number(f.thumbnail_size ?? 0), 0);

/** `size` bytes of a bytea value, read in parts: `part(from, length)` selects `substring(… FROM from FOR length)`. */
async function readParts(
  size: number,
  what: string,
  part: (from: number, length: number) => Promise<Uint8Array | null | undefined>,
): Promise<Uint8Array> {
  const data = new Uint8Array(size);
  let read = 0;

  while (read < size) {
    const bytes = await part(read + 1, Math.min(BLOB_PART_BYTES, size - read));

    if (!bytes?.length) throw new Error(`${what} is no longer stored`);
    data.set(bytes, read);
    read += bytes.length;
  }

  return data;
}

/** A stored blob's bytes, read in parts. */
export function readStoredBlob(store: ComputerStore, sha256: string, size: number): Promise<Uint8Array> {
  return readParts(size, `blob ${sha256.slice(0, 12)}`, async (from, length) => {
    const rows = await store.query<{ data: Uint8Array | null }>(
      "SELECT substring(data FROM $2::integer FOR $3::integer) AS data FROM blobs WHERE sha256 = $1",
      [sha256, from, length],
    );

    return rows[0]?.data;
  });
}

/** The export a target staged for a move (up to the link's 48 MiB), read in parts. */
export async function readMovePayload(store: ComputerStore, moveId: string): Promise<Uint8Array> {
  const query = (columns: string, params: unknown[] = []) =>
    store.query<{ data: Uint8Array | null; size: number | string | null }>(
      `SELECT ${columns} FROM computer_moves WHERE owner_user_id = $1::uuid AND id = $2::uuid`,
      [store.owner, moveId, ...params],
    );

  const size = (await query("octet_length(payload) AS size"))[0]?.size;

  if (size === null || size === undefined) throw new Error(`move ${moveId} has no staged export`);

  return readParts(Number(size), `move ${moveId}`, async (from, length) => {
    const rows = await query("substring(payload FROM $3::integer FOR $4::integer) AS data", [from, length]);

    return rows[0]?.data;
  });
}

export async function readMovedFile(store: ComputerStore, file: MovedFileRow): Promise<link.MovedFile> {
  const thumbnail =
    file.thumb_sha256 && file.thumbnail_size !== null
      ? await readStoredBlob(store, file.thumb_sha256, Number(file.thumbnail_size))
      : new Uint8Array();

  return create(link.MovedFileSchema, {
    attachmentJson: JSON.stringify(file.row),
    data: await readStoredBlob(store, file.sha256, Number(file.size)),
    mimeType: file.mime_type,
    thumbnail,
    thumbnailMimeType: file.thumbnail_mime_type ?? "",
  });
}
