import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { ui } from "@canopy/contracts";
import { splitId, THREAD_MIRROR } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import type { GatewayCore } from "../core/core.ts";
import { coreState } from "../core/core-context.ts";
import { archivedPage } from "../store/archived-pagination.ts";
import { ConfigIds } from "./routed-config.ts";
import type { UiHandlers } from "./ui-service.ts";

const Cursor = Schema.Struct({ scope: Schema.String, at: Schema.String, id: Schema.String });
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Cursor));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const archivedAt = (thread: ui.Thread) =>
  thread.archivedAt
    ? timestampDate(thread.archivedAt).toISOString().slice(0, 19) +
      `.${String(thread.archivedAt.nanos).padStart(9, "0").slice(0, 6)}Z`
    : "";

const compare = (a: ui.Thread, b: ui.Thread) => archivedAt(b).localeCompare(archivedAt(a)) || b.id.localeCompare(a.id);

/** Page the local database and committed remote headers together, without any network or transcript reads. */
export function linkedArchive(core: GatewayCore, local: UiHandlers): UiHandlers["listArchivedThreads"] {
  return async (request, context) => {
    if (!core.computers) return local.listArchivedThreads(request, context);
    const size = Math.min(request.pageSize || 20, 100);
    const projects = [...new Set(request.projectIds)].sort();

    if (projects.some((id) => !uuid.test(splitId(id).id)))
      throw new ConnectError("Invalid archived project filter", Code.InvalidArgument);
    const query = request.query.trim().toLowerCase();

    const scope = createHash("sha256")
      .update(JSON.stringify([core[coreState].options.userId, projects, query]))
      .digest("hex");

    let cursor: typeof Cursor.Type | undefined;

    if (request.pageToken) {
      try {
        if (request.pageToken.length > 2048) throw new Error();
        cursor = decode(Buffer.from(request.pageToken, "base64url").toString());

        if (
          cursor.scope !== scope ||
          !uuid.test(splitId(cursor.id).id) ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(cursor.at) ||
          !Number.isFinite(Date.parse(cursor.at))
        )
          throw new Error();
      } catch {
        throw new ConnectError("Invalid archived page token; reload the first page", Code.InvalidArgument);
      }
    }

    const localProjects = projects.filter((id) => !splitId(id).node);

    const localRequest = create(ui.ListArchivedThreadsRequestSchema, {
      ...request,
      pageSize: size,
      projectIds: localProjects,
      pageToken: "",
    });

    if (cursor)
      localRequest.pageToken = archivedPage(core[coreState].options.userId, localRequest).token(
        cursor.at,
        splitId(cursor.id).id,
      );

    const own =
      projects.length && !localProjects.length
        ? create(ui.ListArchivedThreadsResponseSchema)
        : create(ui.ListArchivedThreadsResponseSchema, await local.listArchivedThreads(localRequest, context));

    const remote = await archivedMirrors(core, projects, query);

    const after = (thread: ui.Thread) =>
      !cursor ||
      archivedAt(thread) < cursor.at ||
      (archivedAt(thread) === cursor.at && thread.id.localeCompare(cursor.id) < 0);

    const candidates = [...own.threads, ...remote.threads.filter(after)].sort(compare);
    const threads = request.countOnly ? [] : candidates.slice(0, size);
    const selected = new Set(threads.map((thread) => thread.id));
    const last = threads.at(-1);

    return create(ui.ListArchivedThreadsResponseSchema, {
      threads,
      sideThreads: [...own.sideThreads, ...remote.sideThreads].filter((thread) => selected.has(thread.parentThreadId)),
      totalCount: own.totalCount + remote.threads.length,
      nextPageToken:
        last && (own.nextPageToken || candidates.length > size)
          ? Buffer.from(JSON.stringify({ scope, at: archivedAt(last), id: last.id })).toString("base64url")
          : "",
    });
  };
}

async function archivedMirrors(core: GatewayCore, projects: string[], query: string) {
  const threads: ui.Thread[] = [];
  const sideThreads: ui.Thread[] = [];
  const computers = core.computers!;

  for (const peer of (await computers.snapshot()).peers) {
    if (peer.relayOrigin || !computers.capabilities(peer.nodeId).includes(THREAD_MIRROR)) continue;
    const ids = await (await ConfigIds.for(core, peer.nodeId)).projects();
    const overview = await computers.mirror.overview(peer.nodeId);
    const names = new Map(overview.projects.map((project) => [ids.toLocal(project.id), project.name.toLowerCase()]));

    const all = await computers.mirror.threads(
      peer.nodeId,
      create(ui.ListThreadsRequestSchema, { includeArchived: true }),
    );

    for (const thread of all) thread.projectId = ids.toLocal(thread.projectId);
    const visible = new Set(all.filter((thread) => !thread.deletedAt).map((thread) => thread.id));
    const children = new Map<string, ui.Thread[]>();

    for (const thread of all) {
      const family = children.get(thread.parentThreadId) ?? [];
      family.push(thread);
      children.set(thread.parentThreadId, family);
    }

    for (const thread of all) {
      if (
        !thread.archivedAt ||
        thread.deletedAt ||
        !names.has(thread.projectId) ||
        (projects.length && !projects.includes(thread.projectId)) ||
        (thread.kind === ui.ThreadKind.SIDE && visible.has(thread.parentThreadId))
      )
        continue;
      const sides = children.get(thread.id) ?? [];

      if (
        query &&
        !thread.title.toLowerCase().includes(query) &&
        !names.get(thread.projectId)?.includes(query) &&
        !sides.some((side) => side.title.toLowerCase().includes(query))
      )
        continue;
      threads.push(thread);
      sideThreads.push(...sides);
    }
  }

  return { threads, sideThreads };
}
