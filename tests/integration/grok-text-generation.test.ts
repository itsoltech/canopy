import { setModules } from "./support/module-settings.ts";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { Provider, ProviderProfileKind, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { WorkerHost, serveLink } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { eventually, startTestGateway } from "./support/gateway.ts";
import { commit, git } from "./support/worktrees.ts";

test.skipIf(!dockerAvailable)(
  "Grok titles and semantic branches go through gateway → worker → isolated CLI ACP",
  async () => {
    const dir = tempDir("canopy-grok-text-link-");
    const data = join(dir, "data");
    const repo = join(dir, "repo");
    const traceFile = join(dir, "trace.jsonl");
    const fake = resolve(import.meta.dir, "../../apps/worker/src/providers/grok/fixtures/text-agent.ts");
    mkdirSync(data);
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    commit(repo);
    const gw = await startTestGateway();
    const added = await gw.addWorker("Grok generation");
    await gw.runtime.runPromise(
      GatewayStore.use((s) =>
        s.setWorkerConfig(
          added.workerId,
          {
            grok: { enabled: true, executablePath: fake },
            claude: { enabled: false },
            codex: { enabled: false },
            profiles: [
              {
                id: "native",
                kind: ProviderProfileKind.NATIVE,
                providers: [Provider.GROK],
                env: [{ name: "GROK_TEXT_TRACE", value: traceFile }],
              },
            ],
          },
          gw.userId,
        ),
      ),
    );
    const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));

    const host = new WorkerHost({
      runtime,
      dataDir: data,
      clientVersion: "test",
      probe: { which: () => fake, version: () => "grok 1.0.70", realDirectory: (p) => p, login: () => "Fixture" },
    });

    const link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: added.credential,
      hello: {
        workerId: added.workerId,
        homeDirectory: homedir(),
        capabilities: ["generate_text", "worktrees", "cancel_text_generation_v1"],
        worktreesRoot: host.worktreesRoot,
        ...(await runtime.runPromise(journalHello())),
      },
    });

    const serving = serveLink(link, host, runtime);

    try {
      await eventually(
        async () => (await gw.api.getOverview({})).workers.find((w) => w.id === added.workerId),
        (w) => !!w?.providerInstances.some((i) => i.harness === Provider.GROK && i.available),
      );
      await gw.api.listModels({ workerId: added.workerId });
      const project = (await gw.api.createProject({ name: "Grok generation" })).project!;

      const workspace = (
        await gw.api.createWorkspace({ projectId: project.id, workerId: added.workerId, rootPath: repo })
      ).workspace!;

      const thread = (
        await gw.api.createThread({
          projectId: project.id,
          workspaceId: workspace.id,
          provider: Provider.GROK,
          model: "grok-4.6",
          initialMessage: "Repair login",
        })
      ).thread!;

      const titled = await eventually(
        () => gw.api.getThread({ threadId: thread.id }),
        (r) => r.thread?.titleSource === "generated",
      );

      expect(titled.thread?.title).toBe("Grok title");
      const current = await gw.api.getWorktreeSettings({ projectId: project.id, workerId: added.workerId });
      await gw.api.updateWorktreeSettings({
        projectId: project.id,
        workerId: added.workerId,
        expectedVersion: current.version,
        settings: { branchNaming: ui.BranchNaming.SEMANTIC, startFromRemote: false },
      });

      const semantic = (
        await gw.api.createThread({
          projectId: project.id,
          workspaceId: workspace.id,
          provider: Provider.GROK,
          model: "grok-4.6",
          title: "Semantic",
          initialMessage: "Repair branch naming",
          workspaceMode: ui.WorkspaceMode.NEW_WORKTREE,
          baseRef: "main",
        })
      ).thread!;

      await eventually(
        () => gw.api.listWorktrees({ worktreeId: semantic.worktree!.id }),
        (r) => r.entries[0]?.worktree?.branch === "fix/grok-text-generation",
      );
      expect(git(semantic.cwd, "branch", "--show-current")).toBe("fix/grok-text-generation");

      // An explicit native Grok model also works outside the former grok-3-mini allowlist.
      const settings = (await gw.api.getSettings({})).user!;
      await gw.api.updateUserSettings({
        expectedVersion: settings.version,
        textGeneration: { provider: Provider.GROK, profileId: "native", model: "grok-4.7-fast" },
      });
      await gw.api.regenerateTitle({ threadId: thread.id });
      await eventually(
        () => gw.api.getThread({ threadId: thread.id }),
        (r) => !r.thread?.titleGenerating,
      );
      expect((await gw.api.getThread({ threadId: thread.id })).thread?.title).toBe("Grok title");

      const trace = readFileSync(traceFile, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              event: string;
              home: string;
              params?: { _meta?: object; mcpServers: unknown[]; cwd: string };
              args: string[];
            },
        );

      const sessions = trace.filter((t) => t.event === "session" && t.params?._meta);
      expect(sessions).toHaveLength(3);
      expect(sessions.slice(0, 2).every((s) => s.args.includes("grok-3-mini"))).toBe(true);
      expect(sessions.at(-1)?.args).toContain("grok-4.7-fast");

      for (const session of sessions) {
        expect(session.params?.mcpServers).toEqual([]);
        expect(session.params?.cwd).not.toBe(repo);
        expect(existsSync(session.home)).toBe(false);
      }

      expect(readdirSync(join(data, "text-generation"))).toEqual([]);

      const latest = (await gw.api.getSettings({})).user!;
      await gw.api.updateUserSettings({
        expectedVersion: latest.version,
        textGeneration: { ...latest.textGeneration!, threadTitleInstructions: "HANG until cancelled" },
      });
      await gw.api.regenerateTitle({ threadId: thread.id });
      expect(
        await eventually(
          async () => readFileSync(traceFile, "utf8"),
          (text) => text.includes("HANG until cancelled"),
        ),
      ).toContain("HANG until cancelled");
      await setModules(gw, "bots");
      await setModules(gw, "threads", "bots");
      expect(
        await eventually(
          async () => readdirSync(join(data, "text-generation")),
          (dirs) => dirs.length === 0,
        ),
      ).toEqual([]);
      expect((await gw.api.getThread({ threadId: thread.id })).thread?.title).toBe("Grok title");

      // A second cancellation may arrive while the original command still awaits CLI installation.
      const connection = gw.core.link.connections.get(added.workerId)!;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      host.cli.settled = async () => {
        entered.resolve();
        await release.promise;
      };

      const commandId = Bun.randomUUIDv7();
      const request = { provider: Provider.GROK, model: "grok-4.6", prompt: "Held in admission" };
      const pending = connection.sendCommand({ case: "generateText", value: request }, 5000, commandId);

      try {
        await entered.promise;
        expect((await connection.sendCommand({ case: "cancelTextGeneration", value: { commandId } })).ok).toBe(true);
      } finally {
        release.resolve();
      }

      expect(await pending).toMatchObject({ ok: false, errorCode: "TEXT_GENERATION_CANCELLED" });
      expect(readFileSync(traceFile, "utf8")).not.toContain(request.prompt);
      expect(
        await connection.sendCommand({ case: "generateText", value: { ...request, prompt: "Fresh request" } }),
      ).toMatchObject({ ok: true, generatedText: "Grok title" });
    } finally {
      link.close();
      await serving;
      await host.close();
      await runtime.dispose();
      await gw.close();
    }
  },
  45_000,
);
