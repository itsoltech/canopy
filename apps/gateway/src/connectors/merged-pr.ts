import { Schema } from "effect";
import { withMcp } from "../bots/mcp.ts";
import type { McpConnection } from "../bots/types.ts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ConnectorsRuntime } from "./runtime.ts";
import type { AccountRow } from "./store.ts";

const Envelope = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Json),
  content: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))),
});

const Pull = Schema.Struct({ number: Schema.Number, head: Schema.Struct({ ref: Schema.String, sha: Schema.String }) });

const Merged = Schema.Struct({
  merged: Schema.Boolean,
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  base: Schema.Struct({ repo: Schema.Struct({ full_name: Schema.String }) }),
});

/** Decode only fixed read operations. Tool output never supplies a URL, tool name or credentials. */
function payload(result: Awaited<ReturnType<Client["callTool"]>>) {
  const envelope = Schema.decodeUnknownSync(Envelope)(result);

  if (envelope.isError) throw new Error("GitHub read failed");

  return envelope.structuredContent ?? JSON.parse(envelope.content?.find((c) => c.type === "text")?.text ?? "null");
}

export async function worktreeMerged(
  runtime: Pick<ConnectorsRuntime, "run">,
  connect: (user: string, id: string) => Promise<{ server: McpConnection; row: AccountRow }>,
  userId: string,
  workerId: string,
  repository: string,
  branch: string,
  head: string,
) {
  const rows = await runtime.run((s) => s.list(userId, { workerId }));

  for (const row of rows.filter((r) => r.connector_type === "github" && r.status === "connected")) {
    try {
      const connection = await connect(userId, row.id);
      const current = await runtime.run((s) => s.list(userId, { workerId }));

      if (!current.some((r) => r.id === row.id && r.revision === connection.row.revision)) continue;
      const merged = await mergedPullRequest(connection.server, repository, branch, head);
      await runtime.run((s) =>
        s.audit({ userId, workerId, accountId: row.id }, "worktree.merged_pr", merged ? "merged" : "unmerged"),
      );

      if (merged) return true;
    } catch {
      // Unavailable or unsupported connector reads leave the independent git fallback authoritative.
    }
  }

  return false;
}

export async function mergedPullRequest(server: McpConnection, repository: string, branch: string, head: string) {
  const [owner, repo] = repository.split("/");

  if (!owner || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repository)) return false;

  return withMcp(server, AbortSignal.timeout(20_000), async (client) => {
    const pulls = Schema.decodeUnknownSync(Schema.Array(Pull))(
      payload(
        await client.callTool({
          name: "list_pull_requests",
          arguments: { owner, repo, state: "closed", head: `${owner}:${branch}`, perPage: 100 },
        }),
      ),
    );

    for (const pull of pulls.filter((p) => p.head.ref === branch && p.head.sha === head)) {
      const detail = Schema.decodeUnknownSync(Merged)(
        payload(
          await client.callTool({
            name: "pull_request_read",
            arguments: { method: "get", owner, repo, pullNumber: pull.number },
          }),
        ),
      );

      if (
        detail.merged &&
        detail.head.ref === branch &&
        detail.head.sha === head &&
        detail.base.repo.full_name.toLowerCase() === repository.toLowerCase()
      )
        return true;
    }

    return false;
  });
}
