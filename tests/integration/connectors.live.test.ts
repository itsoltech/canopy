/** A real Codex and Claude call a fake external MCP via the gateway; credentials never reach either harness. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { PermissionMode, Provider } from '@canopy/contracts';
import { dockerAvailable } from '@canopy/db/testing';
import { GatewayStore } from '@canopy/gateway/store';
import { tempDirs } from '@canopy/testing';
import { journalHello, openGatewayLink } from '@canopy/worker/gateway-link';
import { Journal } from '@canopy/worker/journal';
import { serveLink, WorkerHost } from '@canopy/worker/runtime';
import { Effect, ManagedRuntime } from 'effect';
import { SqlClient } from 'effect/sql';
import { fakeConnector } from './support/connector.ts';
import { eventually, startTestGateway, type TestGateway } from './support/gateway.ts';
import { liveProxyReady, useLiveProxy } from './support/live.ts';

const tempDir = tempDirs();
const proxyUrl = process.env['CANOPY_LIVE_CLIPROXYAPI_URL'], proxyKey = process.env['CANOPY_LIVE_CLIPROXYAPI_KEY'];
const enabled = process.env['CANOPY_LIVE'] === '1' && !!proxyUrl && !!proxyKey && dockerAvailable;
describe.skipIf(!enabled)('connectors (Codex + Claude, live CLIProxyAPI)', () => {
  let gw: TestGateway, fake: ReturnType<typeof fakeConnector>;
  let stop = async () => {};
  let workspaceId = '', projectId = '', data = '', toolName = '';
  const logs: string[] = [];
  const query = <A extends object>(text: string, ...params: unknown[]) => gw.runtime.runPromise(Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; return yield* sql.unsafe<A>(text, params); }));
  beforeAll(async () => {
    fake = fakeConnector(); gw = await startTestGateway();
    const repo = tempDir('oa-connectors-live-repo-'); data = tempDir('oa-connectors-live-data-');
    const added = await gw.runtime.runPromise(GatewayStore.use((s) => s.addWorker({ name: 'connectors-live', ownerUserId: gw.userId })));
    await useLiveProxy(gw, added.workerId, { url: proxyUrl!, key: proxyKey!, allowedRoots: [repo] });
    const runtime = ManagedRuntime.make(Journal.layer(join(data,'journal.db')));
    const host = new WorkerHost({ runtime, dataDir: data, clientVersion: 'connectors-live', log: (message) => logs.push(message) });
    const link = await openGatewayLink({ baseUrl: gw.grpcUrl, credential: added.credential, hello: { workerId: added.workerId, ...(await runtime.runPromise(journalHello())) } });
    const serving = serveLink(link,host,runtime,(message) => logs.push(message));
    stop = async () => { link.close(); await serving; await host.close(); await runtime.dispose(); };
    let account = (await gw.api.saveConnectorAccount({ connectorType: 'custom', name: 'live', url: fake.url, authKind: 'headers', token: fake.secret })).account!;
    account = (await gw.api.setConnectorAccess({ accountId: account.id, expectedRevision: account.revision, workerIds: [added.workerId] })).account!;
    toolName = (await gw.api.testConnector({ accountId: account.id })).tools.find((t) => t.remoteName === 'read_marker')!.name;
    projectId = (await gw.api.createProject({ name: 'Live connectors' })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: added.workerId, rootPath: repo })).workspace!.id;
    await liveProxyReady(gw,added.workerId);
  }, 180_000);
  afterAll(async () => { await stop(); await fake?.close(); await gw?.close(); });
  for (const provider of [Provider.CODEX,Provider.CLAUDE]) test(`${Provider[provider]} calls its granted account through the worker link`, async () => {
    const marker = `CANOPY_${Provider[provider]}_${crypto.randomUUID().slice(0,8)}`;
    const before = fake.calls.length;
    const thread = (await gw.api.createThread({ projectId,workspaceId,provider,providerProfileId: 'cliproxyapi',permissionMode: provider === Provider.CLAUDE ? PermissionMode.READ_ONLY : PermissionMode.FULL_AUTO,
      model: provider === Provider.CODEX ? process.env['CANOPY_LIVE_CODEX_MODEL'] ?? 'gpt-6.1-sol' : process.env['CANOPY_LIVE_CLAUDE_MODEL'] ?? 'claude-haiku-5-5',
      title: `Connector ${Provider[provider]}`,initialMessage: `Call the available connector tool ${toolName} exactly once with {"marker":"${marker}"}. It is on the canopy MCP server in Claude. Discover it with ToolSearch if needed. Do not use shell, network or any other tools. Read the result and reply exactly ${marker}.`,
    })).thread!;
    const done = await eventually(() => gw.api.getThread({ threadId: thread.id }), (r) => ['completed','failed','interrupted'].includes(r.thread?.lastTurnStatus ?? ''), 240_000);
    expect(done.thread?.lastTurnStatus).toBe('completed');
    expect(fake.calls.slice(before)).toEqual([{ name: 'read_marker',args: { marker } }]);
    const audit = await query<{ outcome: string }>("SELECT outcome FROM connector_audit WHERE thread_id=$1::uuid AND tool='read_marker'",thread.id);
    expect(audit.map((r) => r.outcome)).toContain('completed');
    const items = await query<{ content: unknown }>('SELECT content FROM thread_items WHERE thread_id=$1::uuid',thread.id);
    expect(JSON.stringify(items)).toContain(marker); expect(JSON.stringify(items)).toContain('connectorAccountId');
    for (const table of ['thread_items','thread_events','worker_commands','interaction_requests']) expect((await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} r WHERE row_to_json(r)::text LIKE $1`,`%${fake.secret}%`))[0]!.n).toBe(0);
    expect(logs.join('\n')).not.toContain(fake.secret);
    for (const file of readdirSync(data,{ recursive: true }).filter((f) => typeof f === 'string' && f.endsWith('.jsonl'))) expect(readFileSync(join(data,String(file)),'utf8')).not.toContain(fake.secret);
  }, 300_000);
});
