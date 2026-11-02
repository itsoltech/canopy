/**
 * Development smoke client playing the web BFF: talks to GatewayService over gRPC with the service token.
 *   OA_GATEWAY_URL=http://127.0.0.1:7443 OA_UI_SERVICE_TOKEN=... bun tests/integration/smoke/bff-client.ts "Reply OK"
 * Creates a project, a workspace on the first online worker (OA_SMOKE_CWD or its home), a Codex thread
 * with the message, and prints the live transcript until the turn finishes.
 */
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { PermissionMode, Provider, ui } from "@open-agents/contracts";

const baseUrl = Bun.env["OA_GATEWAY_URL"] ?? "http://127.0.0.1:7443";
const token = Bun.env["OA_UI_SERVICE_TOKEN"] ?? "";
const message = Bun.argv[2] ?? "Reply with exactly the word OK and nothing else.";
const api = createClient(
  ui.GatewayService,
  createGrpcTransport({ baseUrl, interceptors: [(next) => (req) => (req.header.set("authorization", `Bearer ${token}`), next(req))] }),
);

let overview = await api.getOverview({});
for (let i = 0; i < 100 && !overview.workers.some((w) => w.online && w.appliedVersion > 0n); i++) {
  await Bun.sleep(100);
  overview = await api.getOverview({});
}
const worker = overview.workers.find((w) => w.online);
if (!worker) throw new Error("no online worker");
console.log(`worker ${worker.name} online, profiles ${worker.profiles.map((p) => `${p.id}:${p.available}`).join(", ")}`);

const project = (await api.createProject({ name: "Smoke" })).project!;
const workspace = (await api.createWorkspace({ projectId: project.id, workerId: worker.id, rootPath: Bun.env["OA_SMOKE_CWD"] || worker.homeDirectory, label: worker.name })).workspace!;
const profile = worker.profiles.find((p) => p.id === "cliproxyapi" && p.available)?.id ?? "";
const thread = (
  await api.createThread({
    projectId: project.id,
    workspaceId: workspace.id,
    title: "Smoke",
    provider: Provider.CODEX,
    providerProfileId: profile,
    model: Bun.env["OA_LIVE_CODEX_MODEL"] ?? (profile ? "gpt-6.1-sol" : ""),
    permissionMode: PermissionMode.READ_ONLY,
    initialMessage: message,
    clientRequestId: Bun.randomUUIDv7(),
  })
).thread!;
console.log(`thread ${thread.id} (${thread.status}) via profile "${profile || "native"}"`);

const controller = new AbortController();
setTimeout(() => controller.abort(), 180_000);
for await (const update of api.watchThread({ threadId: thread.id }, { signal: controller.signal })) {
  const change = update.change;
  if (change.case === "snapshot") console.log(`snapshot: ${change.value.turns.length} turn(s), last_seq ${change.value.lastSeq}`);
  if (change.case === "thread") console.log(`thread status: ${change.value.status}${change.value.statusDetail ? ` (${change.value.statusDetail})` : ""}`);
  if (change.case === "turn") console.log(`turn ${change.value.ordinal}: ${change.value.status}${change.value.error ? ` (${change.value.error})` : ""}`);
  if (change.case === "event") {
    const body = change.value.event?.body;
    if (body?.case === "itemCompleted" && body.value.item?.content.case === "agentMessage") console.log(`agent: ${body.value.item.content.value.text}`);
  }
  if ((change.case === "turn" && ["completed", "failed", "interrupted"].includes(change.value.status)) || (change.case === "thread" && change.value.status === "failed")) break;
}
controller.abort();
