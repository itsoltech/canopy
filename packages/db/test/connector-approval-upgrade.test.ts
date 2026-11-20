import { expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { migrations } from "../src/index.ts";
import { dockerAvailable, startPostgres } from "../src/testing.ts";

const through = (last: number) =>
  Migrator.make({})({
    loader: migrations.pipe(Effect.map((all) => all.filter(([id]) => id <= last))),
    table: "schema_migrations",
  });

test.skipIf(!dockerAvailable)(
  "0181 preserves recoverable connector cards and their existing grants",
  async () => {
    const pg = await startPostgres();
    const runtime = ManagedRuntime.make(pg.layer);
    const owner = crypto.randomUUID();
    const worker = crypto.randomUUID();
    const project = crypto.randomUUID();
    const workspace = crypto.randomUUID();
    const thread = crypto.randomUUID();
    const turn = crypto.randomUUID();
    const account = crypto.randomUUID();
    const cards = ["pending", "allowed", "redacted", "other-tool"].map((label) => ({ label, id: crypto.randomUUID() }));

    try {
      await runtime.runPromise(through(180));
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            yield* sql`INSERT INTO users(id,email,display_name,role) VALUES(${owner}::uuid,'approval@example.test','Owner','user')`;
            yield* sql`INSERT INTO workers(id,owner_user_id,name,credential_hash) VALUES(${worker}::uuid,${owner}::uuid,'Worker','fixture')`;
            yield* sql`INSERT INTO projects(id,owner_user_id,name,slug) VALUES(${project}::uuid,${owner}::uuid,'Project','approval')`;
            yield* sql`INSERT INTO project_workspaces(id,project_id,worker_id,root_path)
        VALUES(${workspace}::uuid,${project}::uuid,${worker}::uuid,'/repo')`;
            yield* sql`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,worker_id,workspace_id,cwd)
        VALUES(${thread}::uuid,${project}::uuid,${owner}::uuid,'main',${thread}::uuid,'worker','codex',${worker}::uuid,${workspace}::uuid,'/repo')`;
            yield* sql`INSERT INTO turns(id,thread_id,ordinal,status,trigger,input,started_at)
        VALUES(${turn}::uuid,${thread}::uuid,1,'running','provider','{}',now())`;
            yield* sql`INSERT INTO connector_accounts(id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,status)
        VALUES(${account}::uuid,${owner}::uuid,'custom','Work','custom_work','https://example.test/mcp','http','headers','connected')`;
            yield* sql`INSERT INTO connector_worker_grants(account_id,worker_id) VALUES(${account}::uuid,${worker}::uuid)`;

            for (const { id, label } of cards) {
              const allowed = label === "allowed";

              const request =
                label === "other-tool"
                  ? {}
                  : {
                      tool_name: "Custom MCP server · Work · write",
                      description: "Allow this connector action?",
                      connector_account_id: account,
                      input: { marker: label === "redacted" ? "[REDACTED]" : "fixture" },
                    };

              yield* sql`INSERT INTO interaction_requests(id,thread_id,turn_id,item_id,kind,tool_name,request,routed_to,status,answered_by,answered_at,response)
          VALUES(${id}::uuid,${thread}::uuid,${turn}::uuid,${id},'permission','custom_work__write',${JSON.stringify(request)}::jsonb,'human',
            ${allowed ? "allowed" : "pending"},${allowed ? owner : null}::uuid,${allowed ? new Date() : null},${allowed ? '{"allow":true}' : null}::jsonb)`;
            }
          }),
        ),
      );
      await runtime.runPromise(through(181));
      await runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          Effect.gen(function* () {
            for (const { id, label } of cards) {
              const [card] =
                yield* sql`SELECT connector_fingerprint,status FROM interaction_requests WHERE id=${id}::uuid`;

              expect(card).toEqual({
                connector_fingerprint: ["pending", "allowed"].includes(label) ? "legacy" : null,
                status: label === "allowed" ? "allowed" : "pending",
              });
            }

            expect(yield* sql`SELECT account_id FROM connector_worker_grants WHERE worker_id=${worker}::uuid`).toEqual([
              { account_id: account },
            ]);
          }),
        ),
      );
    } finally {
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
