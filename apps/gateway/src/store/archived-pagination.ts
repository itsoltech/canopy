import { createHash } from "node:crypto";
import type { ui } from "@canopy/contracts";
import { Schema } from "effect";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const Cursor = Schema.Struct({ scope: Schema.String, at: Schema.String, id: Schema.String });

type Cursor = typeof Cursor.Type;

const decodeCursor = Schema.decodeUnknownSync(Schema.fromJsonString(Cursor));

export const archivedWorkerIds = (ids: string[]) => [...new Set(ids.map((id) => id.toLowerCase()))].sort();

export function archivedScope(userId: string, projects: string[], query: string, workers: string[]) {
  // Preserve the scope of cursors issued before the worker filter existed.
  const filters = workers.length ? [userId, projects, query, workers] : [userId, projects, query];

  return createHash("sha256").update(JSON.stringify(filters)).digest("hex");
}

/** Cursors retain PostgreSQL microseconds; JS Date would lose ties at page boundaries. */
export function archivedPage(userId: string, request: ui.ListArchivedThreadsRequest) {
  const projects = [...new Set(request.projectIds.map((id) => id.toLowerCase()))].sort();
  const workers = archivedWorkerIds(request.workerIds);

  if (projects.some((id) => !uuid.test(id))) throw new Error("invalid archived project filter");

  if (workers.some((id) => !uuid.test(id))) throw new Error("invalid archived worker filter");
  const query = request.query.trim().toLowerCase();
  const scope = archivedScope(userId, projects, query, workers);

  let cursor: Cursor | undefined;

  if (request.pageToken) {
    try {
      if (request.pageToken.length > 2048) throw new Error();
      const value = decodeCursor(Buffer.from(request.pageToken, "base64url").toString());

      if (
        value.scope !== scope ||
        !uuid.test(value.id) ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value.at) ||
        !Number.isFinite(Date.parse(value.at))
      )
        throw new Error();
      cursor = value;
    } catch {
      throw new Error("invalid archived page token; reload the first page");
    }
  }

  return {
    projects,
    workers,
    query,
    cursor,
    size: Math.min(request.pageSize || 20, 100),
    token: (at: string, id: string) => Buffer.from(JSON.stringify({ scope, at, id })).toString("base64url"),
  };
}
