import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { JsonObject } from "@canopy/domain";
import { decodeJsonObject, jsonObject, jsonString } from "../../json.ts";

const root = process.env["FIXTURE_ROOT"] ?? "";
const send = (value: JsonObject) => process.stdout.write(`${JSON.stringify(value)}\n`);
let openedThread = false;

for await (const line of createInterface({ input: process.stdin })) {
  const request = decodeJsonObject(JSON.parse(line));
  const id = request["id"];

  if (id === undefined) continue;
  const method = jsonString(request["method"]);
  const params = jsonObject(request["params"]) ?? {};
  const scenario = decodeJsonObject(JSON.parse(readFileSync(join(root, "scenario.json"), "utf8")));

  // Record the policy fields without the connector credentials attached to the same request.
  appendFileSync(
    join(root, "trace.jsonl"),
    `${JSON.stringify({
      method,
      approvalPolicy: params["approvalPolicy"],
      permissions: params["permissions"],
      sandbox: params["sandbox"],
      sandboxPolicy: params["sandboxPolicy"],
      definition: Object.entries(jsonObject(params["config"]) ?? {}).find(([key]) =>
        key.startsWith("permissions."),
      )?.[1],
    })}\n`,
  );
  let result: JsonObject = {};

  if (method === "initialize") result = { userAgent: `fixture/${scenario["version"] ?? "0.171.0"} (Linux)` };
  else if (method === "config/read")
    result = {
      config: {},
      layers: [
        ...(openedThread && scenario["inactiveProjectAfterStart"]
          ? [{ name: { type: "project" }, version: "1", disabledReason: "Untrusted project" }]
          : []),
        { name: { type: scenario["layer"] ?? "system" }, version: scenario["revision"] ?? "1" },
      ],
    };
  else if (method === "configRequirements/read") result = { requirements: scenario["requirements"] ?? null };
  else if (method === "thread/start" || method === "thread/resume" || method === "thread/fork") {
    openedThread = true;

    if (method === "thread/resume" && scenario["emptyRollout"] === true) {
      send({ id, error: { code: -32600, message: "no rollout found for thread" } });
      continue;
    }

    const name = jsonString(params["permissions"]);
    const definition = jsonObject(jsonObject(params["config"])?.[`permissions.${name}`]);
    result = {
      thread: { id: method === "thread/resume" ? (params["threadId"] ?? "") : crypto.randomUUID(), path: null },
      cwd: params["cwd"] ?? "",
      approvalPolicy: scenario["approvalPolicy"] ?? params["approvalPolicy"] ?? null,
      activePermissionProfile: {
        id: scenario["effectiveProfile"] ?? name,
        extends: definition?.["extends"] ?? null,
      },
      sandbox: { type: "workspaceWrite", networkAccess: jsonObject(definition?.["network"])?.["enabled"] ?? false },
    };
  } else if (method === "mcpServerStatus/list")
    result = {
      data: [{ name: "canopy_connectors", runtimeStatus: "connected", tools: scenario["tools"] ?? {} }],
      nextCursor: null,
    };
  else if (method === "model/list") result = { data: [], nextCursor: null };
  else if (method === "turn/start") result = { turn: { id: crypto.randomUUID() } };

  send({ id, result });
}
