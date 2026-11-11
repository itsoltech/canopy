import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { Schema } from "effect";
import { checkedRun, job, numericId } from "./checks.ts";
import { digest, invalidCursor, type ReadScope } from "./read-scope.ts";

export async function jobLog(scope: ReadScope) {
  const id = numericId(scope.request.resourceId);
  const { prs, row, head } = scope;

  const found = await prs.client.read(row.id, {
    key: `job:${scope.pr.repository_id}:${head}:${id}`,
    path: `${scope.root}/actions/jobs/${id}`,
    ttl: 15_000,
  });

  const j = Schema.decodeUnknownSync(job)(found.payload);
  const run = await checkedRun(scope, String(j.run_id));

  if (String(j.id) !== id || j.head_sha !== head || j.run_attempt !== run.run_attempt)
    throw new ConnectError("This job changed. Refresh the checks.", Code.FailedPrecondition);

  if (j.status !== "completed")
    return create(github.PullRequestJobLogPageSchema, {
      page: scope.page("", true, "Logs are available after this job finishes. Retry then."),
    });
  const key = `logs:${scope.pr.repository_id}:${scope.pr.number}:${head}:${id}:${j.run_attempt}`;
  const result = await prs.client.read(row.id, { key, path: `${scope.root}/actions/jobs/${id}/logs`, ttl: 3_600_000 });

  const log = Schema.decodeUnknownSync(Schema.Struct({ text: Schema.String, truncated: Schema.Boolean }))(
    result.payload,
  );

  const hash = digest(log.text);
  const [snapshot = "", position = "0"] = scope.position.split(":");

  if (scope.position && snapshot !== hash) throw invalidCursor();
  const offset = scope.position ? Number(position) : 0;

  if (!Number.isInteger(offset) || offset < 0 || offset > log.text.length)
    throw new ConnectError("Log page not found", Code.NotFound);
  const lines = log.text.slice(offset).split("\n", 1001);
  let text = "";

  for (const line of lines.slice(0, 1000)) {
    if (Buffer.byteLength(text) + Buffer.byteLength(line) + 1 > 65_536) break;
    text += `${line}\n`;
  }

  // A very long line is bounded without preventing progress through the snapshot.
  if (!text)
    text = Buffer.from(lines[0] ?? "")
      .subarray(0, 65_532)
      .toString("utf8");
  const end = Math.min(log.text.length, offset + text.length);
  await prs.accounts.run((s) => s.audit(prs.accounts.owner, "read_log", scope.pr.id));

  const response = create(github.PullRequestJobLogPageSchema, {
    text,
    firstLine: log.text.slice(0, offset).split("\n").length,
    truncated: log.truncated,
    page: scope.page(
      end < log.text.length ? `${hash}:${end}` : "",
      false,
      log.truncated ? "Log truncated. Open on GitHub for the full log." : "",
    ),
  });

  return response;
}
