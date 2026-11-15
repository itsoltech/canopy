import { expect, test } from "bun:test";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { onBffTargetChange, setBffTarget } from "@canopy/domain/bff-target";
import { QueryCacheDisposed } from "@canopy/domain/shared-query";
import { BffSession } from "../../apps/web/src/lib/server/bff-state.ts";
import { startTestGateway } from "./support/gateway.ts";

test.skipIf(!dockerAvailable)(
  "target replacement closes shared streams and fences a real private read",
  async () => {
    const gateway = await startTestGateway();
    const previous = globalThis.canopyBffTarget;
    const first = new BffSession(gateway.api);
    let replacement: BffSession | undefined;
    const stop = onBffTargetChange(() => first.close());
    const abort = new AbortController();
    const stream = first.subscribe([], "", abort.signal)[Symbol.asyncIterator]();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    try {
      const initial = await stream.next();
      expect(initial.value?.kind).toBe("overview");
      const project = (await gateway.api.createProject({ name: "BFF target fence" })).project!;

      const workspace = (
        await gateway.api.createWorkspace({
          projectId: project.id,
          workerId: gateway.workerId,
          rootPath: "/repo/bff-state",
        })
      ).workspace!;

      const thread = (
        await gateway.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX })
      ).thread!;

      const pending = first.reads.read(`GetThreadPanel:${thread.id}`, ui.ThreadPanelSchema, async () => {
        const result = await gateway.api.getThreadPanel({ threadId: thread.id });
        started.resolve();
        await release.promise;

        return result;
      });

      const outcome = pending.then(
        () => undefined,
        (cause: unknown) => cause,
      );

      await started.promise;
      setBffTarget({ gatewayUrl: "http://replacement.invalid", serviceToken: "test-service-token" });
      expect(await outcome).toBeInstanceOf(QueryCacheDisposed);
      release.resolve();
      expect((await stream.next()).done).toBe(true);
      await expect(first.overview.overview()).rejects.toThrow("closed");
      await expect(
        first.reads.read("ListProxies", ui.ListProxiesResponseSchema, () => gateway.api.listProxies({})),
      ).rejects.toBeInstanceOf(QueryCacheDisposed);
      replacement = new BffSession(gateway.api);
      expect((await replacement.overview.overview()).workers.some((worker) => worker.id === gateway.workerId)).toBe(
        true,
      );
    } finally {
      release.resolve();
      abort.abort();
      stop();
      first.close();
      replacement?.close();
      globalThis.canopyBffTarget = previous;
      await stream.return?.(undefined);
      await gateway.close();
    }
  },
  30_000,
);
