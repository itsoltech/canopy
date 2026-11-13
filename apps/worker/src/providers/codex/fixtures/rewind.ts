/** Persistent app-server fixture: the answer exposes exactly the model's current conversation. */
import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Schema } from "effect";
import { decodeJsonObject, jsonObject, jsonString } from "../../json.ts";
import { HttpMcp, httpTools } from "../../../../../../tests/integration/fixtures/instance-mcp.ts";

const home = process.env["CODEX_HOME"]!;
const turnsSchema = Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String }));
const catalogs = new Map<string, string[]>();

async function configure(threadId: string, params: Schema.Schema.Type<typeof Schema.JsonObject>) {
  const config = Schema.decodeUnknownSync(
    Schema.Struct({ mcp_servers: Schema.optionalKey(Schema.Record(Schema.String, HttpMcp)) }),
  )(params["config"] ?? {});

  catalogs.set(threadId, await httpTools(config.mcp_servers?.["canopy_connectors"]));
}

const read = (id: string) =>
  Schema.decodeUnknownSync(turnsSchema)(JSON.parse(readFileSync(join(home, `${id}.json`), "utf8")));

const save = (id: string, turns: Schema.Schema.Type<typeof turnsSchema>) =>
  writeFileSync(join(home, `${id}.json`), JSON.stringify(turns));

const send = (message: Schema.Schema.Type<typeof Schema.JsonObject>) =>
  process.stdout.write(JSON.stringify(message) + "\n");

const native = (id: string) => ({ thread: { id, path: null } });

for await (const line of createInterface({ input: process.stdin })) {
  const request = decodeJsonObject(JSON.parse(line));
  const id = request["id"];

  if (id === undefined) continue;
  const params = jsonObject(request["params"]) ?? {};
  const thread = jsonString(params["threadId"]) ?? "";

  switch (request["method"]) {
    case "model/list": {
      const gate = process.env["CANOPY_REWIND_TEST_GATE"];

      if (gate) {
        writeFileSync(join(gate, "entered"), "");

        // Keep reading requests: rewind can replace the entry while turn settings are pending.
        const watcher = watch(gate, () => {
          if (!existsSync(join(gate, "release"))) return;
          watcher.close();
          send({ id, result: { data: [], nextCursor: null } });
        });

        if (existsSync(join(gate, "release"))) {
          watcher.close();
          send({ id, result: { data: [], nextCursor: null } });
        }
      } else send({ id, result: { data: [], nextCursor: null } });
      break;
    }

    case "initialize":
      send({ id, result: { userAgent: "rewind-fixture" } });
      break;
    case "thread/start": {
      const created = crypto.randomUUID();
      save(created, []);
      await configure(created, params);
      send({ id, result: native(created) });
      break;
    }

    case "thread/fork": {
      const turns = read(thread);
      const boundary = turns.findIndex((turn) => turn.id === params["lastTurnId"]);

      if (boundary < 0) {
        send({ id, error: { code: -32602, message: "unknown boundary" } });
        break;
      }

      const created = crypto.randomUUID();
      save(created, turns.slice(0, boundary + 1));
      await configure(created, params);
      send({ id, result: native(created) });
      break;
    }

    case "thread/resume":
      read(thread);
      await configure(thread, params);
      send({ id, result: native(thread) });
      break;
    case "mcpServerStatus/list":
      send({
        id,
        result: {
          data: [
            {
              name: "canopy_connectors",
              runtimeStatus: "connected",
              tools: Object.fromEntries((catalogs.get(thread) ?? []).map((name) => [name, { name }])),
            },
          ],
          nextCursor: null,
        },
      });
      break;
    case "turn/start": {
      const input = Schema.decodeUnknownSync(
        Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
      )(params["input"]);

      const turns = [
        ...read(thread),
        { id: crypto.randomUUID(), text: input.map((entry) => entry.text ?? "").join("") },
      ];

      save(thread, turns);
      const turn = { id: turns.at(-1)!.id, status: "inProgress", items: [], error: null };
      send({ id, result: { turn } });
      send({ method: "turn/started", params: { threadId: thread, turn } });
      send({
        method: "item/completed",
        params: {
          threadId: thread,
          turnId: turn.id,
          item: {
            id: crypto.randomUUID(),
            type: "agentMessage",
            text: turns.map((entry) => entry.text).join(" | "),
            phase: "final_answer",
          },
        },
      });
      send({ method: "turn/completed", params: { threadId: thread, turn: { ...turn, status: "completed" } } });
      break;
    }

    default:
      send({ id, result: {} });
  }
}
