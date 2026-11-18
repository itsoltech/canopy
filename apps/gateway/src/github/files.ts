import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import { jsonMessage, type ReadScope } from "./read-scope.ts";
import { viewedFiles } from "./viewed.ts";

const file = Schema.Struct({
  filename: Schema.String,
  previous_filename: Schema.optional(Schema.String),
  status: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  patch: Schema.optional(Schema.String),
  blob_url: Schema.String,
});

const commit = Schema.Struct({
  sha: Schema.String,
  commit: Schema.Struct({ message: Schema.String, author: Schema.NullOr(Schema.Struct({ name: Schema.String })) }),
});

const pageNumber = (value: string) => {
  const n = Number(value || "1");

  if (!Number.isInteger(n) || n < 1 || n > 100) throw new ConnectError("File page not found", Code.NotFound);

  return n;
};

function patchState(f: typeof file.Type) {
  const patch = f.patch;
  const lines = patch?.split("\n") ?? [];

  const oversized =
    !!patch &&
    (Buffer.byteLength(patch) > 262_144 ||
      lines.length > 4000 ||
      lines.filter((line) => line.startsWith("+")).length < f.additions ||
      lines.filter((line) => line.startsWith("-")).length < f.deletions);

  return oversized
    ? "truncated"
    : patch
      ? "available"
      : f.status === "renamed" && !f.additions && !f.deletions
        ? "rename"
        : !f.additions && !f.deletions
          ? "binary"
          : "unavailable";
}

function fileInfo(f: typeof file.Type & { patch_state: string }, page: number) {
  return create(github.PullRequestFileSchema, {
    path: f.filename,
    previousPath: f.previous_filename ?? "",
    state: f.status,
    additions: f.additions,
    deletions: f.deletions,
    url: f.blob_url,
    sourcePage: page,
    patchState: f.patch_state,
  });
}

async function commitAllowed(scope: ReadScope) {
  const sha = scope.request.commitSha;

  if (!sha) return;

  if (!/^[a-f0-9]{40}$/.test(sha)) throw new ConnectError("Commit not found", Code.NotFound);

  // Membership is checked through the PR's own commit connection, never through an arbitrary ref.
  for (let page = 1; page <= 100; page++) {
    const result = await scope.prs.client.read(scope.row.id, {
      key: `commitsraw:${scope.pr.id}:${scope.snapshot.baseSha}:${scope.head}:${page}`,
      path: `${scope.root}/pulls/${scope.pr.number}/commits?per_page=30&page=${page}`,
      ttl: 86_400_000,
      project: async (value) => {
        await scope.fresh();

        return value;
      },
    });

    const list = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(commit) }))(result.payload).items;

    if (list.some((c) => c.sha === sha)) return;

    if (list.length < 30) break;
  }

  throw new ConnectError("Commit not found in this pull request", Code.NotFound);
}

async function rawFiles(scope: ReadScope, page: number) {
  const sha = scope.request.commitSha;

  const result = await scope.prs.client.read(
    scope.row.id,
    {
      key: `patches:${scope.pr.id}:${scope.snapshot.baseSha}:${scope.head}:${sha}:${page}`,
      path: sha
        ? `${scope.root}/commits/${sha}?per_page=30&page=${page}`
        : `${scope.root}/pulls/${scope.pr.number}/files?per_page=30&page=${page}`,
      ttl: 86_400_000,
      project: async (value, headers) => {
        const list = sha
          ? Schema.decodeUnknownSync(Schema.Struct({ files: Schema.Array(file) }))(value).files
          : Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(file) }))(value).items;

        // The REST response carries no PR revision. Verify before publishing it under the SHA cache key.
        if (!sha) await scope.fresh();

        return Schema.decodeUnknownSync(Schema.JsonObject)({
          items: list.map((f) => {
            const state = patchState(f);

            return { ...f, patch: state === "available" ? (f.patch ?? "") : "", patch_state: state };
          }),
          more: (headers.get("link") ?? "").includes('rel="next"'),
        });
      },
    },
    scope.request.refresh,
  );

  return Schema.decodeUnknownSync(
    Schema.Struct({
      items: Schema.Array(Schema.Struct({ ...file.fields, patch_state: Schema.String })),
      more: Schema.Boolean,
    }),
  )(result.payload);
}

export async function files(scope: ReadScope) {
  const page = pageNumber(scope.position);
  await commitAllowed(scope);

  const [raw, viewed] = await Promise.all([
    rawFiles(scope, page),
    viewedFiles(scope.prs, scope.row, scope.pr, scope.head, scope.snapshot.baseSha, scope.request.refresh),
  ]);

  const limited = page === 100 && raw.more;

  await scope.fresh();

  return create(github.PullRequestFilesPageSchema, {
    files: raw.items.map((f) => ({
      ...fileInfo(f, page),
      viewerViewedState: viewed.states.get(f.filename) ?? "",
    })),
    viewedCount: viewed.count,
    viewedTotal: viewed.states.size,
    viewedComplete: viewed.complete,
    page: scope.page(
      raw.more && !limited ? String(page + 1) : "",
      limited,
      limited ? "Only the first 3000 files are available. Open on GitHub to see more." : "",
    ),
  });
}

export async function diff(scope: ReadScope) {
  const page = pageNumber(scope.request.resourceId);
  await commitAllowed(scope);
  const raw = await rawFiles(scope, page);
  await scope.fresh();
  const found = raw.items.find((f) => f.filename === scope.request.path);

  if (!found) throw new ConnectError("File not found in this pull request", Code.NotFound);

  return create(github.PullRequestDiffSchema, {
    file: fileInfo(found, page),
    patch: found.patch ?? "",
    page: scope.page(
      "",
      found.patch_state !== "available",
      found.patch_state === "available" ? "" : patchDetail(found.patch_state),
    ),
  });
}

function patchDetail(state: string) {
  if (state === "binary") return "Binary file. Open on GitHub to view this file.";

  if (state === "rename") return "File renamed with no text changes.";

  if (state === "truncated") return "Patch exceeds the size or line limit. Open on GitHub to read the full file.";

  return "Patch unavailable or limited by GitHub. Open on GitHub to read this file.";
}

export async function commits(scope: ReadScope) {
  const page = pageNumber(scope.position);

  return scope.read(github.PullRequestCommitsPageSchema, {
    path: `${scope.root}/pulls/${scope.pr.number}/commits?per_page=30&page=${page}`,
    project: async (value, headers) => {
      const items = Schema.decodeUnknownSync(Schema.Struct({ items: Schema.Array(commit) }))(value).items;

      return jsonMessage(
        github.PullRequestCommitsPageSchema,
        create(github.PullRequestCommitsPageSchema, {
          commits: items.map((c) => ({
            sha: c.sha,
            subject: c.commit.message.split("\n")[0] ?? "",
            author: c.commit.author?.name ?? "Deleted user",
          })),
          page: scope.page((headers.get("link") ?? "").includes('rel="next"') ? String(page + 1) : ""),
        }),
      );
    },
  });
}
