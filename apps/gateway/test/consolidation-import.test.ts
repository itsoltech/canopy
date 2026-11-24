import "reflect-metadata";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { SQL } from "bun";
import { create, toJson } from "@bufbuild/protobuf";
import { SandboxProfileBindingSchema, SandboxProfileSchema } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { sandboxBinding } from "@canopy/domain/sandbox-profiles";
import { tempDir } from "@canopy/testing";
import { startTestPostgresServer, testAdmin } from "../../../packages/db/src/testing-server.ts";
import { generateIdentity } from "../src/computers/identity.ts";
import {
  importConsolidation,
  inspectConsolidation,
  readConsolidationReceipt,
  type ConsolidationInput,
} from "../src/migration/consolidation-import.ts";
import {
  exportConsolidationProjection,
  loadApprovedConsolidationSecrets,
  materializeConsolidationProjection,
} from "../src/migration/consolidation-projection.ts";
import { withTrialDatabase } from "../src/migration/postgres-target.ts";
import { commitSourceFence } from "../src/migration/relocation-fence.ts";
import { decryptSecret, encryptSecret } from "../src/store/secrets.ts";

const uuid = Bun.randomUUIDv7;
const ownerEmail = "consolidation@example.test";
const fixtureValue = "consolidation secret fixture";
const snoozedUntil = "2099-12-31T23:59:59.123Z";
const memoryCreatedAt = "2026-08-01T09:15:30.123Z";
const sandbox = sandboxBinding(create(SandboxProfileSchema, { id: uuid(), name: "Offline" }));
const sandboxJson = toJson(SandboxProfileBindingSchema, sandbox);

type Fixture = Awaited<ReturnType<typeof seedInstallation>>;

type FixtureRows = Awaited<ReturnType<typeof seedRows>>;

async function seedInstallation(admin: SQL, port: number, name: "source" | "target") {
  const database = "consolidation_" + name;
  await admin.unsafe(`CREATE DATABASE ${database} TEMPLATE canopy_template`);
  const url = `postgresql://postgres:test@127.0.0.1:${port}/${database}`;
  const secretsKey = randomBytes(32);
  const ownerUserId = uuid();
  const { nodeId, certificate, privateKey } = await generateIdentity();

  const env = {
    CANOPY_DATABASE_URL: url,
    CANOPY_DEV_USER_EMAIL: ownerEmail,
    CANOPY_SECRETS_KEY: secretsKey.toString("base64"),
  };

  await using sql = new SQL({ url, max: 1 });

  await sql`INSERT INTO users(id,email,display_name,role) VALUES (${ownerUserId},${ownerEmail},'Gateway owner','admin')`;
  await sql`INSERT INTO computer_identity(owner_user_id,node_id,name,certificate,private_key)
    VALUES(${ownerUserId},${nodeId},${name},${certificate},${encryptSecret(secretsKey, privateKey)})`;

  return { url, env, ownerUserId, nodeId, secretsKey };
}

async function seedRows(source: Fixture, target: Fixture, operationId: string) {
  await using s = new SQL({ url: source.url, max: 1 });
  await using d = new SQL({ url: target.url, max: 1 });
  const localOwner = source.ownerUserId;
  const centralOwner = target.ownerUserId;
  const worker = uuid();
  const revoked = uuid();
  const workspace = uuid();
  const sourceProject = uuid();
  const targetProject = uuid();
  const sourceConnector = uuid();
  const targetConnector = uuid();
  const sourceProjectGlobal = uuid();
  const targetProjectGlobal = uuid();
  const thread = uuid();
  const turn = uuid();
  const fork = uuid();
  const child = uuid();
  const centralChild = uuid();
  const archived = uuid();
  const archivedChild = uuid();
  const moved = uuid();
  const attachment = uuid();
  const schedule = uuid();
  const secret = uuid();
  const targetSecret = uuid();
  const foreignOwner = uuid();
  const foreignProject = uuid();
  const foreignThread = uuid();
  const bot = uuid();
  const botTurn = uuid();
  const botMessage = uuid();
  const botApproval = uuid();
  const blob = Buffer.from("attachment fixture");
  const hash = Bun.SHA256.hash(blob, "hex");
  const oldRef = moved + "~" + source.nodeId.slice(0, 16);

  await s`INSERT INTO gateway_relocation_fence(operation_id,state) VALUES(${operationId},'drained')`;
  await d`INSERT INTO gateway_relocation_fence(operation_id,state) VALUES(${operationId},'drained')`;
  await s`INSERT INTO users(id,email,display_name,role) VALUES(${foreignOwner},'other@example.test','Other','user')`;
  await s`INSERT INTO projects(id,owner_user_id,name,slug,color) VALUES
    (${sourceProject},${localOwner},'Source project','common','#3366ff'),(${foreignProject},${foreignOwner},'Foreign','foreign',NULL)`;
  await d`INSERT INTO projects(id,owner_user_id,name,slug,color)
    VALUES (${targetProject},${centralOwner},'Target project','common','#ff6633')`;
  await s`INSERT INTO config_items(owner_user_id,kind,global_id,local_id,revision)
    VALUES(${localOwner},'project',${sourceProjectGlobal},${sourceProject},1)`;
  await d`INSERT INTO config_items(owner_user_id,kind,global_id,local_id,revision)
    VALUES(${centralOwner},'project',${targetProjectGlobal},${targetProject},1)`;
  await s`INSERT INTO connector_accounts(id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,status,no_project)
    VALUES(${sourceConnector},${localOwner},'custom','Source connector','fixture','https://source.example.test','http','headers','disconnected',true)`;
  await d`INSERT INTO connector_accounts(id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,status,all_projects)
    VALUES(${targetConnector},${centralOwner},'custom','Target connector','fixture','https://target.example.test','http','headers','disconnected',true)`;
  await s`INSERT INTO connector_project_grants(account_id,project_id) VALUES(${sourceConnector},${sourceProjectGlobal})`;
  await d`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,provider,runtime,status)
    VALUES(${moved},${targetProject},${centralOwner},'main',${moved},'openai','gateway','idle')`;
  await d`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,provider,runtime,status,remote_parent_kind,remote_parent_ref)
    VALUES(${centralChild},${targetProject},${centralOwner},'main',${centralChild},'openai','gateway','idle','thread',
      ${thread + "~" + source.nodeId.slice(0, 16)})`;
  await s`INSERT INTO worktree_settings(owner_user_id,project_id,settings,version)
    VALUES(${localOwner},${sourceProject},'{"enabled":false}',1)`;
  await d`INSERT INTO worktree_settings(owner_user_id,project_id,settings,version)
    VALUES(${centralOwner},${targetProject},'{"enabled":true}',1)`;
  await s`INSERT INTO workers(id,owner_user_id,name,credential_hash,revoked_at)
    VALUES(${worker},${localOwner},'moving','active-worker-fixture-hash',NULL),
      (${revoked},${localOwner},'revoked','revoked-worker-fixture-hash',now())`;
  await s`INSERT INTO project_workspaces(id,project_id,worker_id,root_path) VALUES(${workspace},${sourceProject},${worker},'/fixture')`;
  await s`INSERT INTO checkout_heads(workspace_id,branch) VALUES(${workspace},'owned-fixture')`;
  await seedNonHomeWorkspaces(s, sourceProject, foreignOwner);

  for (const id of [thread, archived, moved])
    await s`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,worker_id,workspace_id,cwd,status,provider_thread_id)
      VALUES(${id},${sourceProject},${localOwner},'main',${id},'worker','codex',${worker},${workspace},'/fixture','idle',${"session-" + id})`;

  await s`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,status)
    VALUES(${foreignThread},${foreignProject},${foreignOwner},'main',${foreignThread},'gateway','openai','idle')`;
  await s`UPDATE threads SET moved_to=${target.nodeId},deleted_at=now() WHERE id=${moved}`;
  await s`INSERT INTO computer_redirects(owner_user_id,kind,item_id,from_node_id,home_node_id,basis,moved_at)
    VALUES(${localOwner},'thread',${moved},${source.nodeId},${target.nodeId},'local_move',now())`;
  await s`INSERT INTO turns(id,thread_id,ordinal,status,trigger,author_user_id,input,first_seq,last_seq)
    VALUES(${turn},${thread},1,'completed','user',${localOwner},'{}',1,1)`;
  await s`UPDATE threads SET provider_thread_id='current-fixture-session' WHERE id=${thread}`;
  await s`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,worker_id,workspace_id,cwd,status,fork_source_thread_id,fork_after_turn_id)
    VALUES(${fork},${sourceProject},${localOwner},'main',${fork},'worker','codex',${worker},${workspace},'/fixture','idle',${thread},${turn})`;
  await s`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,worker_id,workspace_id,cwd,status,remote_parent_ref,remote_parent_kind,remote_parent_detached)
    VALUES(${child},${sourceProject},${localOwner},'main',${child},'worker','codex',${worker},${workspace},'/fixture','idle',${oldRef},'thread',true)`;
  await s`INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,parent_thread_id,depth,runtime,provider,worker_id,workspace_id,cwd,status)
    VALUES(${archivedChild},${sourceProject},${localOwner},'side',${archived},${archived},1,'worker','codex',${worker},${workspace},'/fixture','idle')`;
  await s`UPDATE threads SET archived_at=now() WHERE id IN (${archived},${archivedChild})`;
  await s`INSERT INTO worker_commands(id,worker_id,thread_id,kind,payload,expires_at,status)
    VALUES(${uuid()},${worker},${archived},'createThread',''::bytea,now(),'completed')`;
  const sandboxSettings = JSON.stringify({ permissionMode: "FULL_AUTO", sandboxProfile: sandboxJson });

  await s`UPDATE threads SET settings=settings||${sandboxSettings}::text::jsonb WHERE id=${archived}`;
  await s`INSERT INTO worker_commands(id,worker_id,thread_id,kind,payload,expires_at,status,sandbox_digest)
    VALUES(${uuid()},${worker},${archived},'startTurn',''::bytea,now(),'completed',${sandbox.digest})`;
  await s`INSERT INTO blobs(sha256,size_bytes,data) VALUES(${hash},${blob.length},${blob})`;
  await s`INSERT INTO attachments(id,owner_user_id,thread_id,turn_id,sha256,name,mime_type,kind,size_bytes)
    VALUES(${attachment},${localOwner},${thread},${turn},${hash},'fixture.txt','text/plain','file',${blob.length})`;
  await s`INSERT INTO schedules(id,thread_id,project_id,kind,prompt,run_at,next_run_at,created_by_user_id)
    VALUES(${schedule},${thread},${sourceProject},'once','fixture',now(),now(),${localOwner})`;
  await s`UPDATE threads SET origin='schedule',schedule_id=${schedule},schedule_run=1,
    snoozed=true,snoozed_until=${snoozedUntil}::timestamptz WHERE id=${thread}`;

  await s`INSERT INTO secrets(id,owner_user_id,name,ciphertext,key_id,created_by)
    VALUES(${secret},${localOwner},'matched',${encryptSecret(source.secretsKey, fixtureValue)},'env-v1',${localOwner})`;
  await d`INSERT INTO secrets(id,owner_user_id,name,ciphertext,key_id,created_by)
    VALUES(${targetSecret},${centralOwner},'matched',${encryptSecret(target.secretsKey, "existing target fixture")},'env-v1',${centralOwner})`;
  await s`INSERT INTO worker_configs(worker_id,version,config,updated_by) VALUES(${worker},1,'{}',${localOwner})`;
  await s`INSERT INTO worker_config_secrets(worker_id,secret_id) VALUES(${worker},${secret})`;

  await s`INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance)
    VALUES(${bot},${localOwner},'bot',jsonb_build_object('workerId',${worker}::text),'codex','native')`;
  await s`INSERT INTO bot_turns(id,bot_id,client_request_id,input,status) VALUES(${botTurn},${bot},'msg','fixture','completed')`;
  await s`INSERT INTO bot_tool_calls(id,turn_id,call_key,tool,arguments,status)
    VALUES(${botApproval},${botTurn},'send','{"source":"platform","name":"send_message"}',
      jsonb_build_object('thread_id',${thread}::text,'text','fixture'),'completed')`;
  await s`INSERT INTO bot_approvals(id,bot_id,turn_id,kind,prompt,status,answered_at,restricted_thread_id)
    VALUES(${botApproval},${bot},${botTurn},'approval','Send to the delegated thread','approved',now(),${thread})`;
  await s`INSERT INTO bot_messages(id,bot_id,turn_id,message_key,sender_id,recipient_id,kind,text)
    VALUES(${botMessage},${bot},${botTurn},'answer',${bot},'user','message','fixture')`;
  await s`UPDATE bots SET last_read_seq=(SELECT seq FROM bot_messages WHERE id=${botMessage}) WHERE id=${bot}`;
  await d`SELECT nextval('bot_messages_seq_seq')`;

  await d`INSERT INTO computer_peers(owner_user_id,node_id,name,certificate,fingerprint)
    VALUES(${centralOwner},${source.nodeId},'source','fixture','fixture')`;
  await d`INSERT INTO computer_mirror_state(owner_user_id,origin_node_id) VALUES(${centralOwner},${source.nodeId})`;
  await d`INSERT INTO computer_mirror_threads(owner_user_id,origin_node_id,generation,thread_id,snapshot,thread_metadata)
    SELECT owner_user_id,origin_node_id,generation,${thread},${blob},${blob} FROM computer_mirror_state`;

  const memory = await seedMemory(s, d, source, target, {
    sourceProject,
    targetProject,
    worker,
    bot,
    thread,
    turn,
    child,
    foreignOwner,
    foreignProject,
  });

  await s`UPDATE schedules SET memory_audience=${"legacy:schedule:" + schedule} WHERE id=${schedule}`;

  return {
    memory,
    sourceProject,
    targetProject,
    targetConnector,
    targetProjectGlobal,
    worker,
    revoked,
    workspace,
    thread,
    turn,
    child,
    centralChild,
    fork,
    moved,
    archived,
    archivedChild,
    foreignThread,
    targetSecret,
    attachment,
    schedule,
    bot,
    botApproval,
    hash,
  };
}

async function seedMemory(
  s: SQL,
  d: SQL,
  source: Fixture,
  target: Fixture,
  f: {
    sourceProject: string;
    targetProject: string;
    worker: string;
    bot: string;
    thread: string;
    turn: string;
    child: string;
    foreignOwner: string;
    foreignProject: string;
  },
) {
  const owner = source.ownerUserId;

  const account = uuid(),
    route = uuid(),
    conversation = uuid();

  await s`INSERT INTO messenger_accounts(id,owner_user_id,name,external_id,credentials)
    VALUES(${account},${owner},'Chat fixture','T1',${encryptSecret(source.secretsKey, fixtureValue)})`;
  await s`INSERT INTO bot_channel_routes(id,owner_user_id,bot_id,account_id)
    VALUES(${route},${owner},${f.bot},${account})`;
  await s`INSERT INTO bot_channel_conversations(id,route_id,channel_id,thread_id,open_until)
    VALUES(${conversation},${route},'C1','123',now())`;
  await s`INSERT INTO agent_memory_scopes(owner_user_id,project_id,worker_id,bot_id,conversation_id) VALUES
    (${owner},${f.sourceProject},NULL,NULL,NULL),(${owner},${f.sourceProject},${f.worker},NULL,NULL),
    (${owner},NULL,NULL,${f.bot},NULL),(${owner},NULL,NULL,${f.bot},${conversation}),
    (${f.foreignOwner},${f.foreignProject},NULL,NULL,NULL)`;
  await s`INSERT INTO agent_memory_notes(id,owner_user_id,scope_key,title,body,aliases,pinned,revision,source_kind,source_id,source_turn_id,created_at)
    SELECT gen_random_uuid(),owner_user_id,scope_key,split_part(scope_key,':',1),'source note','{alternate}',true,3,
      'thread',${f.thread},${f.turn},CASE WHEN scope_key NOT LIKE 'bot:%' THEN ${memoryCreatedAt}::timestamptz END
    FROM agent_memory_scopes`;
  await s`INSERT INTO agent_memory_operations(owner_user_id,operation_id,request_hash,note_id,note_revision)
    VALUES(${owner},'old-operation','digest',${uuid()},1)`;

  const [clock] =
    await d`INSERT INTO agent_memory_scopes(owner_user_id,project_id) VALUES(${target.ownerUserId},${f.targetProject}) RETURNING revision`;

  await d`INSERT INTO agent_memory_notes(id,owner_user_id,scope_key,title,body)
    SELECT ${uuid()},owner_user_id,scope_key,'existing','target note' FROM agent_memory_scopes`;
  const audience = `conversation:${f.bot}:${conversation}`;
  await s`UPDATE threads SET memory_audience=${audience} WHERE id=${f.thread}`;
  await s`UPDATE threads SET memory_audience=${"conversation:" + uuid() + ":" + uuid()} WHERE id=${f.child}`;

  return { audience, clock: String(clock.revision) };
}

async function seedNonHomeWorkspaces(sql: SQL, project: string, foreignOwner: string) {
  const foreign = uuid();
  const shared = uuid();
  await sql`INSERT INTO workers(id,owner_user_id,name,credential_hash)
    VALUES(${foreign},${foreignOwner},'foreign','foreign-worker-fixture-hash'),
      (${shared},NULL,'shared','shared-worker-fixture-hash')`;

  for (const worker of [foreign, shared]) {
    const workspace = uuid();
    await sql`INSERT INTO project_workspaces(id,project_id,worker_id,root_path)
      VALUES(${workspace},${project},${worker},'/non-home-fixture')`;
    await sql`INSERT INTO checkout_heads(workspace_id,branch) VALUES(${workspace},'non-home-fixture')`;
  }
}

async function checkResult(target: Fixture, source: Fixture, f: FixtureRows, operationId: string) {
  await using sql = new SQL({ url: target.url, max: 1 });

  await checkMemory(sql, target.ownerUserId, f);

  const [placement] = await sql`SELECT project_id,owner_user_id,worker_id,workspace_id,provider_thread_id,schedule_id,
    snoozed,snoozed_until=${snoozedUntil}::timestamptz AS deadline_preserved
    FROM threads WHERE id=${f.thread}`;

  expect(placement).toEqual({
    project_id: f.targetProject,
    owner_user_id: target.ownerUserId,
    worker_id: f.worker,
    workspace_id: f.workspace,
    provider_thread_id: "current-fixture-session",
    schedule_id: f.schedule,
    snoozed: true,
    deadline_preserved: true,
  });
  expect(await sql`SELECT workspace_id,branch FROM checkout_heads`).toEqual([]);
  const [point] = await sql`SELECT provider_session_id FROM turns WHERE id=${f.turn}`;
  expect(point?.provider_session_id).toBe("session-" + f.thread);
  const [fork] = await sql`SELECT fork_after_turn_id FROM threads WHERE id=${f.fork}`;
  expect(fork?.fork_after_turn_id).toBe(f.turn);

  const [archivedChild] =
    await sql`SELECT parent_thread_id,archived_at IS NOT NULL AS archived FROM threads WHERE id=${f.archivedChild}`;

  expect(archivedChild).toEqual({ parent_thread_id: f.archived, archived: true });
  const [parent] = await sql`SELECT remote_parent_ref,remote_parent_detached FROM threads WHERE id=${f.child}`;
  expect(parent).toEqual({ remote_parent_ref: f.moved, remote_parent_detached: false });

  const [centralChild] =
    await sql`SELECT remote_parent_ref,remote_parent_detached FROM threads WHERE id=${f.centralChild}`;

  expect(centralChild).toEqual({ remote_parent_ref: f.thread, remote_parent_detached: false });
  const [worktree] = await sql`SELECT settings FROM worktree_settings WHERE project_id=${f.targetProject}`;
  expect(worktree?.settings).toEqual({ enabled: true });

  const unexpected = await sql`SELECT id FROM threads WHERE id=${f.foreignThread}`;
  expect(unexpected).toEqual([]);
  const [moved] = await sql`SELECT runtime FROM threads WHERE id=${f.moved}`;
  expect(moved?.runtime).toBe("gateway");
  expect(await sql`SELECT origin_node_id FROM computer_mirror_threads`).toEqual([]);

  const [alias] =
    await sql`SELECT home_node_id FROM computer_redirects WHERE item_id=${f.thread} AND from_node_id=${source.nodeId}`;

  expect(alias?.home_node_id).toBe(target.nodeId);

  const [ids] = await sql`SELECT target_id FROM gateway_consolidation_ids WHERE operation_id=${operationId}
    AND kind='project' AND source_id=${f.sourceProject}`;

  expect(ids?.target_id).toBe(f.targetProject);

  const [revoked] =
    await sql`SELECT credential_hash,revoked_at IS NOT NULL AS revoked FROM workers WHERE id=${f.revoked}`;

  expect(revoked).toEqual({ credential_hash: "revoked-worker-fixture-hash", revoked: true });

  const [secret] = await sql<{ secret_id: string; ciphertext: Uint8Array }[]>`SELECT secret_id,ciphertext
    FROM worker_config_secrets JOIN secrets ON id=secret_id WHERE worker_id=${f.worker}`;

  expect(secret?.secret_id).toBe(f.targetSecret);
  expect(secret && decryptSecret(target.secretsKey, secret.ciphertext) === fixtureValue).toBe(true);
  expect(() => secret && decryptSecret(source.secretsKey, secret.ciphertext)).toThrow();

  const [message] =
    await sql`SELECT last_read_seq,seq FROM bots b JOIN bot_messages m ON m.bot_id=b.id WHERE b.id=${f.bot}`;

  expect(message?.last_read_seq).toBe(message?.seq);
  expect(await sql`SELECT status,restricted_thread_id FROM bot_approvals WHERE id=${f.botApproval}`).toEqual([
    { status: "approved", restricted_thread_id: f.thread },
  ]);

  const [blob] =
    await sql`SELECT encode(sha256(data),'hex') AS hash FROM blobs JOIN attachments USING(sha256) WHERE id=${f.attachment}`;

  expect(blob?.hash).toBe(f.hash);
}

async function checkMemory(sql: SQL, owner: string, f: FixtureRows) {
  const keys = [
    `project:${f.targetProject}`,
    `worker:${f.targetProject}:${f.worker}`,
    `bot:${f.bot}`,
    f.memory.audience,
  ];

  const notes = await sql`SELECT title,scope_key,revision,aliases,pinned,source_id,source_turn_id,
      created_at=${memoryCreatedAt}::timestamptz AS creation_time_preserved FROM agent_memory_notes
    WHERE owner_user_id=${owner} AND body='source note' ORDER BY scope_key`;

  expect(notes).toEqual(
    keys.sort().map((scope_key) => ({
      title: scope_key.split(":")[0],
      scope_key,
      revision: 3,
      aliases: ["alternate"],
      pinned: true,
      source_id: f.thread,
      source_turn_id: f.turn,
      creation_time_preserved: scope_key.startsWith("bot:") ? null : true,
    })),
  );
  expect(await sql`SELECT body FROM agent_memory_notes WHERE title='existing'`).toEqual([{ body: "target note" }]);

  const [clock] =
    await sql`SELECT revision::text FROM agent_memory_scopes WHERE scope_key=${"project:" + f.targetProject}`;

  expect(clock.revision).not.toBe(f.memory.clock);
  expect(await sql`SELECT owner_user_id FROM agent_memory_operations WHERE operation_id='old-operation'`).toEqual([
    { owner_user_id: owner },
  ]);
  const [live] = await sql`SELECT memory_audience FROM threads WHERE id=${f.thread}`;
  const [orphan] = await sql`SELECT memory_audience FROM threads WHERE id=${f.child}`;
  const [schedule] = await sql`SELECT memory_audience FROM schedules WHERE id=${f.schedule}`;
  expect(live.memory_audience).toBe(f.memory.audience);
  expect(orphan.memory_audience).toMatch(/^legacy:consolidation:/);
  expect(schedule.memory_audience).toMatch(/^legacy:consolidation:/);
}

async function fixtureFailure(target: Fixture, enabled: boolean) {
  await using sql = new SQL({ url: target.url, max: 1 });

  if (enabled) {
    await sql`CREATE FUNCTION reject_consolidation_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture failure'; END $$`;
    await sql`CREATE TRIGGER reject_consolidation_fixture BEFORE INSERT ON schedules
      FOR EACH ROW EXECUTE FUNCTION reject_consolidation_fixture()`;
  } else {
    const workers = await sql`SELECT id FROM workers`;
    expect(workers).toEqual([]);
    const [trigger] = await sql`SELECT tgenabled FROM pg_trigger WHERE tgname='threads_before_insert'`;
    expect(trigger?.tgenabled).toBe("O");
    await sql`DROP TRIGGER reject_consolidation_fixture ON schedules`;
    await sql`DROP FUNCTION reject_consolidation_fixture()`;
  }
}

test.skipIf(!dockerAvailable)(
  "consolidates a fenced linked computer through an isolated projection in one transaction",
  async () => {
    const server = await startTestPostgresServer();

    try {
      await using admin = testAdmin(server.port);
      const source = await seedInstallation(admin, server.port, "source");
      const target = await seedInstallation(admin, server.port, "target");
      const operationId = uuid();
      const fixture = await seedRows(source, target, operationId);
      const archive = join(tempDir("canopy-consolidation-"), "final");
      const projection = await exportConsolidationProjection(source.env, archive, { operationId, offline: true });

      await withTrialDatabase(target.env, operationId, async (staging) => {
        await materializeConsolidationProjection(staging, archive, { targetDatabaseUrl: target.url, operationId });

        const input: ConsolidationInput = {
          operationId,
          archiveSha256: projection.archiveSha256,
          sourceDatabaseUrl: staging.CANOPY_DATABASE_URL ?? "",
          targetDatabaseUrl: target.url,
          source: { nodeId: source.nodeId, ownerUserId: source.ownerUserId },
          target: { secretsKey: target.secretsKey, ownerUserId: target.ownerUserId },
        };

        // A target transcript whose original audience vanished must not become readable by the
        // incoming conversation with matching IDs. Clearing the fixture restores the normal review.
        {
          await using sql = new SQL({ url: target.url, max: 1 });
          await sql`UPDATE threads SET memory_audience=${fixture.memory.audience} WHERE id=${fixture.centralChild}`;
          const collision = await inspectConsolidation(input);
          expect(collision.blockers).toContainEqual({
            table: "threads",
            key: fixture.centralChild,
            reason: "destination_memory_audience_collision",
          });
          await sql`UPDATE threads SET memory_audience='' WHERE id=${fixture.centralChild}`;
        }

        const review = await inspectConsolidation(input);
        expect(review.blockers).toEqual([]);
        expect(review.conflicts.map(({ table }) => table).sort()).toEqual([
          "connector_accounts",
          "projects",
          "secrets",
          "worktree_settings",
        ]);
        expect(review.secrets).toHaveLength(2);
        expect(review.counts.threads).toBe(5);
        expect(review.counts.schedules).toBe(1);
        expect(review.counts.project_workspaces).toBe(1);
        expect(review.counts.connector_project_grants).toBe(1);
        expect(review.counts.checkout_heads).toBe(0);

        const approval = {
          reviewDigest: review.reviewDigest,
          conflictChoices: Object.fromEntries(
            review.conflicts.map(({ id, table }) => [
              id,
              table === "worktree_settings" ? ("target" as const) : ("source" as const),
            ]),
          ),
          approvedSecretIds: review.secrets.map(({ id }) => id),
        };

        await commitSourceFence(source.env, operationId);

        const selected = await loadApprovedConsolidationSecrets(source.env, archive, {
          operationId,
          archiveSha256: projection.archiveSha256,
          approvedSecretIds: approval.approvedSecretIds,
        });

        const approvedSecrets = selected.map(({ id, value }) => ({
          id,
          plaintext: Buffer.from(value, "base64").toString("utf8"),
        }));

        await expect(importConsolidation(input, approval, [])).rejects.toThrow("approved secret transfer");
        await fixtureFailure(target, true);
        await expect(importConsolidation(input, approval, approvedSecrets)).rejects.toThrow(
          "Could not import schedules",
        );
        expect(await readConsolidationReceipt(input)).toBeNull();
        await fixtureFailure(target, false);

        const receipt = await importConsolidation(input, approval, approvedSecrets);
        expect(receipt.alreadyApplied).toBe(false);
        const replay = { ...receipt, alreadyApplied: true };
        expect(await importConsolidation(input, approval, [])).toEqual(replay);
        expect(await readConsolidationReceipt(input)).toEqual(replay);
      });

      await checkResult(target, source, fixture, operationId);

      await using sql = new SQL({ url: target.url, max: 1 });
      expect(await sql`SELECT color FROM projects WHERE id=${fixture.targetProject}`).toEqual([{ color: "#3366ff" }]);
      expect(await sql`SELECT settings->'sandboxProfile' AS profile FROM threads WHERE id=${fixture.archived}`).toEqual(
        [{ profile: sandboxJson }],
      );
      expect(
        await sql`SELECT sandbox_digest,status FROM worker_commands WHERE thread_id=${fixture.archived} ORDER BY kind`,
      ).toEqual([
        { sandbox_digest: null, status: "completed" },
        { sandbox_digest: sandbox.digest, status: "completed" },
      ]);
      await expect(sql`INSERT INTO worker_commands(id,worker_id,thread_id,kind,payload,expires_at)
        VALUES(${uuid()},${fixture.worker},${fixture.archived},'startTurn',''::bytea,now()+interval '1 minute')`).rejects.toThrow(
        "selected sandbox profile",
      );
      expect(
        await sql`SELECT name,all_projects,no_project FROM connector_accounts WHERE id=${fixture.targetConnector}`,
      ).toEqual([{ name: "Source connector", all_projects: false, no_project: true }]);
      expect(
        await sql`SELECT project_id FROM connector_project_grants WHERE account_id=${fixture.targetConnector}`,
      ).toEqual([{ project_id: fixture.targetProjectGlobal }]);
    } finally {
      await server.stop();
    }
  },
  60_000,
);
