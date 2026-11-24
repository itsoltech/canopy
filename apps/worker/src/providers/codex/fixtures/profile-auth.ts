import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import { readLines } from "../rpc.ts";

const root = process.argv[2] ?? "";

if (root !== process.env["CODEX_HOME"]) throw new Error("The selected profile's launch options changed");

const config = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.Json,
      renewed: Schema.optionalKey(Schema.Json),
      rpcError: Schema.optionalKey(Schema.Boolean),
    }),
  ),
)(readFileSync(join(root, "fixture.json"), "utf8"));

const Request = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.optionalKey(Schema.Int),
    method: Schema.String,
    params: Schema.optionalKey(Schema.NullOr(Schema.JsonObject)),
  }),
);

for await (const line of readLines(Bun.stdin.stream())) {
  const { id, method, params } = Schema.decodeSync(Request)(line);

  if (id === undefined) continue;
  const refresh = params?.["refreshToken"] === true;
  appendFileSync(join(root, "requests.jsonl"), `${JSON.stringify({ pid: process.pid, method, refresh })}\n`);

  if (method === "initialize") {
    process.stdout.write(`${JSON.stringify({ id, result: { userAgent: "fixture/0.172.0" } })}\n`);

    continue;
  }

  if (method === "config/read") {
    const result = { config: { model_provider: "openai" }, origins: {}, layers: null };
    process.stdout.write(`${JSON.stringify({ id, result })}\n`);

    continue;
  }

  if (method === "configRequirements/read") {
    process.stdout.write(`${JSON.stringify({ id, result: { requirements: null } })}\n`);

    continue;
  }

  if (method !== "getAuthStatus" || params?.["includeToken"] !== true || config.rpcError) {
    process.stdout.write(`${JSON.stringify({ id, error: { code: -32601, message: "fixture private credential" } })}\n`);

    continue;
  }

  const result = refresh && config.renewed !== undefined ? config.renewed : config.status;
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}
