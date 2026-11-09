import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import type { ArchivedFilter, ArchivedPageState } from "@canopy/domain/archived-threads";

export const archiveKey = (filter: ArchivedFilter) =>
  JSON.stringify([[...filter.projectIds].sort(), filter.query.trim().toLowerCase()]);

/** Two length-delimited protobuf messages, confined to this versioned local cache. */
export function encodeArchive(filter: ArchivedFilter, state: ArchivedPageState) {
  const request = toBinary(
    ui.ListArchivedThreadsRequestSchema,
    create(ui.ListArchivedThreadsRequestSchema, { ...filter, countOnly: !state.loaded }),
  );

  const page = toBinary(
    ui.ListArchivedThreadsResponseSchema,
    create(ui.ListArchivedThreadsResponseSchema, { ...state, totalCount: state.totalCount ?? 0 }),
  );

  const bytes = new Uint8Array(4 + request.length + page.length);
  new DataView(bytes.buffer).setUint32(0, request.length);
  bytes.set(request, 4);
  bytes.set(page, 4 + request.length);

  return bytes;
}

export function decodeArchive(bytes: Uint8Array) {
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);

  if (length > bytes.length - 4) throw new Error("Invalid archived cache");
  const filter = fromBinary(ui.ListArchivedThreadsRequestSchema, bytes.subarray(4, 4 + length));
  const page = fromBinary(ui.ListArchivedThreadsResponseSchema, bytes.subarray(4 + length));

  return {
    filter,
    state: {
      threads: page.threads,
      sideThreads: page.sideThreads,
      nextPageToken: page.nextPageToken,
      totalCount: filter.countOnly ? undefined : page.totalCount,
      loaded: !filter.countOnly,
      loading: false,
      error: "",
    },
  };
}
