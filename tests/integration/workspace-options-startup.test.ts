import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { readWorkspaceRefs } from "../../apps/web/src/lib/features/worktrees/server/workspace-refs.ts";
import { eventually, startTestGateway } from "./support/gateway.ts";
import { commit, git } from "./support/worktrees.ts";

test.skipIf(!dockerAvailable)(
  "the composer recovers workspace options for the same project after a cold worker times out",
  async () => {
    const dir = tempDir("canopy-workspace-options-startup-");
    const data = join(dir, "data");
    const repo = join(dir, "repo");
    mkdirSync(data);
    git(dir, "init", "-qb", "main", repo);
    commit(repo);
    git(repo, "worktree", "add", "-qb", "previous", join(dir, "previous"));

    const gw = await startTestGateway();
    const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));

    const host = new WorkerHost({
      runtime,
      dataDir: data,
      clientVersion: "test",
      probe: { which: () => null, version: () => undefined, realDirectory: () => undefined },
    });

    const releaseConfig = Promise.withResolvers<void>();
    const configReceived = Promise.withResolvers<void>();

    try {
      const { workerId, credential } = await gw.addWorker("Starting worker");
      const { project } = await gw.api.createProject({ name: "Default project" });

      const workspace = await gw.runtime.runPromise(
        GatewayStore.use((s) => s.createWorkspace({ projectId: project!.id, workerId, rootPath: repo, label: "" })),
      );

      const link = await openGatewayLink({
        baseUrl: gw.grpcUrl,
        credential,
        hello: {
          workerId,
          capabilities: ["worktrees", "git_worktree_discovery"],
          worktreesRoot: host.worktreesRoot,
          host: { os: process.platform },
          ...(await runtime.runPromise(journalHello())),
        },
      });

      async function* messages() {
        for await (const message of link.messages) {
          if (message.payload.case === "config") {
            configReceived.resolve();
            await releaseConfig.promise;
          }

          yield message;
        }
      }

      const serving = serveLink({ ...link, messages: messages() }, host, runtime).catch((cause: unknown) => {
        if (!(cause instanceof ConnectError && cause.code === Code.Unavailable)) throw cause;
      });

      try {
        const overview = await eventually(
          () => gw.api.getOverview({}),
          (value) => value.workers.some((worker) => worker.id === workerId && worker.online && worker.worktrees),
        );

        expect(overview.workers.find((worker) => worker.id === workerId)).toMatchObject({
          online: true,
          worktrees: true,
          appliedVersion: 0n,
        });
        await configReceived.promise;
        const failures: Code[] = [];
        const workspaceIds: string[] = [];

        const refs = await readWorkspaceRefs(
          {
            listGitRefs: async (request, options) => {
              workspaceIds.push(request.workspaceId ?? "");

              try {
                return await gw.api.listGitRefs(request, options);
              } catch (cause) {
                failures.push(ConnectError.from(cause).code);
                releaseConfig.resolve();
                throw cause;
              }
            },
          },
          create(ui.ListGitRefsRequestSchema, { workspaceId: workspace.id }),
          AbortSignal.timeout(45_000),
        );

        expect(failures).toEqual([Code.DeadlineExceeded]);
        expect(workspaceIds).toEqual([workspace.id, workspace.id]);
        expect(refs.supported).toBe(true);
        expect(refs.refs?.currentBranch).toBe("main");
        expect(refs.worktrees).toMatchObject([{ branch: "previous", external: true }]);
      } finally {
        releaseConfig.resolve();
        link.close();
        await serving;
      }
    } finally {
      await host.close();
      await runtime.dispose();
      await gw.close();
    }
  },
  60_000,
);
