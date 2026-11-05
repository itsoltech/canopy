import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { REMOTE_THREADS, THREAD_MIRROR } from "@canopy/domain/computers";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./computers.ts";
import { eventually } from "./gateway.ts";
import { worktreeFixture } from "./worktrees.ts";

/** Two desktop homes, real Git origin reads over gRPC, and isolated provider stand-ins. */
export async function linkedProjectFixture(dir: string) {
  mkdirSync(join(dir, "a"));
  mkdirSync(join(dir, "b"));

  const a = await worktreeFixture(join(dir, "a"), {
    role: "desktop",
    originUrl: "git@GitHub.com:itsoltech/pinpoint.git",
  });

  const b = await worktreeFixture(join(dir, "b"), {
    role: "desktop",
    originUrl: "https://github.com/itsoltech/pinpoint/",
  });

  const connect = (fixture: typeof a) =>
    linkedComputers({
      store: new ComputerStore(fixture.gw.runtime, fixture.gw.userId, fixture.gw.secretsKey),
      host: "127.0.0.1",
      heartbeatMs: 100,
      capabilities: ["presence", "unlink", REMOTE_THREADS, THREAD_MIRROR],
      serve: remoteServe(uiHandlers(fixture.gw.core), fixture.gw.core),
    });

  const la = connect(a);
  const lb = connect(b);
  a.gw.core.computers = la;
  a.gw.core.network = la.options.network;
  b.gw.core.computers = lb;
  b.gw.core.network = lb.options.network;
  await la.start();
  await lb.start();
  await a.gw.api.renameProject({ projectId: a.project.id, name: "Pinpoint" });
  await b.gw.api.renameProject({
    projectId: b.project.id,
    name: "Pinpoint on the studio computer with a long project name",
  });
  const invitation = await a.gw.api.createComputerPairing({});
  await b.gw.api.linkComputer({ address: la.addresses[0]!, code: invitation.code });

  const ready = await eventually(
    () => a.gw.api.getOverview({}),
    (overview) =>
      overview.projects.some(
        (project) => project.nodeId === lb.hello().nodeId && project.workspaces.some((ws) => ws.gitOrigin),
      ),
  );

  if (!ready.projects.some((project) => project.nodeId === lb.hello().nodeId))
    throw new Error("Linked fixture did not connect");

  return {
    a,
    b,
    la,
    lb,
    close: async () => {
      await Promise.allSettled([la.close(), lb.close()]);
      await a.close();
      await b.close();
    },
  };
}
