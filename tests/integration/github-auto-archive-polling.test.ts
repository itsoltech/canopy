import { setModules } from "./support/module-settings.ts";
import { describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { eventually, startTestGateway } from "./support/gateway.ts";
import { linkedRead } from "./support/github-read.ts";
import { pollingFixture } from "./support/github-polling.ts";

describe.skipIf(!dockerAvailable)("durable merge archival without a visible client", () => {
  for (const initial of ["OPEN", "CLOSED"])
    test(`${initial}: discovers merge after a gateway restart`, async () => {
      const fixture = pollingFixture();
      fixture.state.pr = initial;
      fixture.state.running = false;
      let gw = await startTestGateway({ github: fixture.options });

      try {
        const { thread } = await linkedRead(gw, fixture);
        await eventually(
          async () => (await gw.api.getThread({ threadId: thread })).thread!.status,
          (status) => status === "idle",
        );
        const settings = (await gw.api.getSettings({})).user!;
        await gw.api.updateUserSettings({
          expectedVersion: settings.version,
          threadDefaults: { ...settings.threadDefaults!, autoArchiveOnMerge: true },
        });
        await gw.core.github.background.tick();
        expect((await gw.api.getThread({ threadId: thread })).thread!.archivedAt).toBeUndefined();

        if (initial === "CLOSED") {
          expect(fixture.requests.some((r) => r.path.endsWith("/check-runs"))).toBe(false);
          fixture.state.pr = "OPEN";
          fixture.state.updatedAt = "2026-11-10T12:01:00Z";
          fixture.advance(70_000);
          await gw.core.github.background.tick();
          expect((await gw.api.listThreadPullRequests({ threadId: thread })).links[0]!.summary!.state).toBe("open");
        }

        const storage = {
          pg: gw.pg,
          secretsKey: gw.secretsKey,
          workerId: gw.workerId,
          workerCredential: gw.workerCredential,
        };

        await setModules(gw, "bots");
        await gw.close(true);
        gw = await startTestGateway({ github: fixture.options, storage });
        fixture.state.pr = "MERGED";
        fixture.state.updatedAt = "2026-11-10T12:02:00Z";
        fixture.advance(70_000);
        await gw.core.github.background.tick();

        const stillOpen = await gw.core.linkedAgents.query("SELECT archived_at FROM threads WHERE id=$1::uuid", [
          thread,
        ]);

        expect(stillOpen).toEqual([{ archived_at: null }]);
        await setModules(gw, "threads", "bots");
        await gw.core.github.background.tick();
        const archived = (await gw.api.getThread({ threadId: thread })).thread!;
        expect(archived.archivedAt).toBeDefined();
        expect(archived.archivedBy).toBe("merge");
        const after = fixture.requests.length;
        fixture.advance(70_000);
        await gw.core.github.background.tick();
        expect(fixture.requests).toHaveLength(after);
      } finally {
        await gw.close();
        fixture.close();
      }
    }, 60_000);
});
