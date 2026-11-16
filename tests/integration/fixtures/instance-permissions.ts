/** Claude control requests exercised through the real SDK, without invoking a model. */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import type { JsonObject } from "@canopy/domain";

const Record = Schema.Struct({
  event: Schema.Literals(["sandbox", "mode", "permission", "question", "after-switch"]),
  pid: Schema.Number,
  session: Schema.String,
  enabled: Schema.optionalKey(Schema.Boolean),
  mode: Schema.optionalKey(Schema.String),
  behavior: Schema.optionalKey(Schema.String),
});

const Control = Schema.Struct({
  subtype: Schema.String,
  mode: Schema.optionalKey(Schema.String),
  settings: Schema.optionalKey(
    Schema.Struct({ sandbox: Schema.optionalKey(Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) })) }),
  ),
});

const Reply = Schema.Struct({ behavior: Schema.Literals(["allow", "deny"]) });
const pathOf = (trace: string) => join(dirname(trace), "permissions.jsonl");

export function permissionRecords(trace: string) {
  const path = pathOf(trace);

  return existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .slice(0, -1)
        .map((line) => Schema.decodeSync(Schema.fromJsonString(Record))(line))
    : [];
}

export function sdkPermissions(session: string, send: (message: JsonObject) => void) {
  const pending = new Map<string, (response: JsonObject) => void>();

  const record = (fields: Omit<typeof Record.Type, "pid" | "session">) => {
    const trace = process.env["INSTANCE_TRACE"];

    if (trace) appendFileSync(pathOf(trace), JSON.stringify({ ...fields, pid: process.pid, session }) + "\n");
  };

  const request = (event: "permission" | "question" | "after-switch") =>
    new Promise<void>((resolve) => {
      const id = crypto.randomUUID();
      const question = event === "question";
      pending.set(id, (response) => {
        record({ event, behavior: Schema.decodeUnknownSync(Reply)(response).behavior });
        resolve();
      });
      send({
        type: "control_request",
        request_id: id,
        request: {
          subtype: "can_use_tool",
          tool_name: question ? "AskUserQuestion" : "Bash",
          tool_use_id: `live-${event}`,
          input: question
            ? { questions: [{ question: "Continue the fixture?", header: "Continue", options: [{ label: "Yes" }] }] }
            : { command: "echo fixture" },
        },
      });
    });

  return {
    control(request: JsonObject) {
      if (request["subtype"] !== "apply_flag_settings" && request["subtype"] !== "set_permission_mode") return;
      const control = Schema.decodeUnknownSync(Control)(request);

      if (control.settings?.sandbox?.enabled !== undefined)
        record({ event: "sandbox", enabled: control.settings.sandbox.enabled });

      if (control.mode !== undefined) record({ event: "mode", mode: control.mode });
    },
    response(id: string, response: JsonObject) {
      const resolve = pending.get(id);

      if (!resolve) return false;
      pending.delete(id);
      resolve(response);

      return true;
    },
    async turn(text: string) {
      if (!text.includes("LIVE_PERMISSIONS")) return;
      await Promise.all([request("permission"), request("question")]);
      await request("after-switch");
    },
  };
}
