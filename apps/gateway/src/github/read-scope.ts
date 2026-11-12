import { create, fromJsonString, toJson, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Schema } from "effect";
import type { GitHubPullRequests } from "./pull-requests.ts";
import type { GitHubRead } from "./client.ts";
import { githubFailure } from "./http.ts";
import { uuid } from "./records.ts";

const Cursor = Schema.Struct({ binding: Schema.String, position: Schema.String, snapshot: Schema.String });
export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const invalidCursor = () => new ConnectError("This page changed. Refresh to continue.", Code.FailedPrecondition);
export const changesUpdated = () => new ConnectError("Changes updated. Refresh the files.", Code.FailedPrecondition);

/** Access is checked before cache; a cursor is authenticated for one owner/account/PR/filter/SHA. */
export async function readScope(
  prs: GitHubPullRequests,
  request: github.PullRequestPageRequest,
  kind: string,
  wait = false,
  verifiedSnapshot?: github.PullRequestSnapshot,
) {
  const { accounts, repositories, client } = prs;

  if (!uuid(request.pullRequestId)) throw new ConnectError("Pull request not found", Code.NotFound);
  const pr = await accounts.run((s) => s.prOwned(accounts.owner, request.pullRequestId));
  // Explicit refresh must wait for an expired Summary, including between mutation and receipt inspection.
  const snapshot = verifiedSnapshot ?? (await prs.load(pr.repository_name, pr.number, false, false, request.refresh));
  const { mapping, row } = await repositories.selected(pr.repository_name);
  const access = await accounts.access.token(row.id);

  if (snapshot.accountId !== row.id || snapshot.accessRevision !== BigInt(access.row.revision)) throw invalidCursor();
  const head = snapshot.summary?.headSha ?? "";

  if ((request.headSha && request.headSha !== head) || (request.baseSha && request.baseSha !== snapshot.baseSha))
    throw changesUpdated();

  const bind = (readKind: string, resource = request.resourceId) =>
    digest(
      JSON.stringify([
        accounts.owner,
        row.id,
        String(row.revision),
        String(mapping.revision),
        pr.id,
        head,
        snapshot.baseSha,
        readKind,
        filterBinding(request),
        resource,
        request.path,
      ]),
    );

  const binding = bind(kind);
  const sign = (value: string) => createHmac("sha256", access.token).update(value).digest();

  const { position, snapshot: generation } = request.cursor
    ? parseCursor(request.cursor, binding, sign)
    : { position: "", snapshot: Bun.randomUUIDv7() };

  const cursor = (next: string, cursorBinding = binding) => {
    if (!next) return "";

    const text = Buffer.from(JSON.stringify({ binding: cursorBinding, position: next, snapshot: generation })).toString(
      "base64url",
    );

    return `${text}.${sign(text).toString("base64url")}`;
  };

  const page = (next = "", partial = false, detail = "") =>
    create(github.PullRequestPageInfoSchema, {
      nextCursor: cursor(next),
      headSha: head,
      baseSha: snapshot.baseSha,
      completeness: partial ? "partial" : "complete",
      detail,
      stale: snapshot.stale,
      verifiedAt: timestampFromDate(new Date(accounts.http.now())),
      snapshot: generation,
    });

  async function read<D extends DescMessage>(schema: D, options: Omit<GitHubRead, "key">): Promise<MessageShape<D>> {
    const key = `${kind}:${pr.repository_id}:${pr.number}:${binding}:${digest(position)}`;
    const cached = await client.cached(row, key);

    if (!request.refresh && !wait && cached?.payload && Number(new Date(cached.expires_at)) <= accounts.http.now()) {
      // The viewer already has verified data. Revalidate through the same durable single flight.
      void client
        .read(row.id, { ...options, key })
        .catch(async (cause) => {
          if (githubFailure(cause).code === Code.PermissionDenied) {
            client.memory.clear();
            await accounts.run((s) => s.cacheInvalidate(accounts.owner, row.id));
          }
        })
        .catch(() => {});

      return fromJsonString(schema, JSON.stringify(cached.payload));
    }

    try {
      const value = await client.read(row.id, { ...options, key }, request.refresh);
      const current = await repositories.selected(pr.repository_name);

      if (
        current.row.id !== row.id ||
        current.row.revision !== row.revision ||
        current.mapping.revision !== mapping.revision
      )
        throw invalidCursor();

      return fromJsonString(schema, JSON.stringify(value.payload));
    } catch (cause) {
      const error = githubFailure(cause);

      if (cached?.payload && [Code.Unavailable, Code.ResourceExhausted].includes(error.code)) {
        const value = {
          ...cached.payload,
          page: {
            ...Schema.decodeUnknownSync(Schema.JsonObject)(cached.payload["page"]),
            stale: true,
            detail: error.rawMessage,
          },
        };

        return fromJsonString(schema, JSON.stringify(value));
      }

      if (error.code === Code.PermissionDenied) {
        client.memory.clear();
        await accounts.run((s) => s.cacheInvalidate(accounts.owner, row.id));
      }

      throw error;
    }
  }

  return {
    prs,
    request,
    pr,
    snapshot,
    row,
    binding,
    head,
    position,
    cursor,
    page,
    read,
    fresh: () => freshPage(prs, pr.repository_name, pr.number, head, snapshot.baseSha),
    replyCursor: (id: string, next: string) => cursor(next, bind("reviews", id)),
    root: `/repos/${pr.repository_name}`,
    variables: { owner: pr.repository_name.split("/")[0]!, name: pr.repository_name.split("/")[1]!, number: pr.number },
  };
}

export type ReadScope = Awaited<ReturnType<typeof readScope>>;

async function freshPage(prs: GitHubPullRequests, repository: string, number: number, head: string, base: string) {
  const current = await prs.load(repository, number, true);

  if (current.summary?.headSha !== head || current.baseSha !== base) throw changesUpdated();

  if (current.stale) throw new ConnectError("Connect to load this page. Retry when connected.", Code.Unavailable);
}

function parseCursor(value: string, binding: string, sign: (text: string) => Uint8Array) {
  try {
    if (value.length > 8192) throw invalidCursor();
    const [text = "", signature = ""] = value.split(".");
    const expected = sign(text);
    const actual = Buffer.from(signature, "base64url");

    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw invalidCursor();
    const cursor = Schema.decodeUnknownSync(Cursor)(JSON.parse(Buffer.from(text, "base64url").toString()));

    if (cursor.binding !== binding) throw invalidCursor();

    return cursor;
  } catch {
    throw invalidCursor();
  }
}

const filterBinding = (r: github.PullRequestPageRequest) => [r.kind, r.author, r.oldestFirst, r.commitSha];

export const jsonMessage = <D extends DescMessage>(schema: D, value: MessageShape<D>) =>
  Schema.decodeUnknownSync(Schema.JsonObject)(toJson(schema, value));

export function graphErrors(value: Schema.JsonObject) {
  const parsed = Schema.decodeUnknownSync(
    Schema.Struct({ errors: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String) }))) }),
  )(value);

  if (parsed.errors?.some((e) => ["FORBIDDEN", "NOT_FOUND"].includes(e.type ?? "")))
    throw new ConnectError("GitHub access is unavailable. Check repository permissions.", Code.PermissionDenied);

  return !!parsed.errors?.length;
}
