import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { GITHUB_ACCOUNTS, GITHUB_HOME, REMOTE_THREADS, qualifyId } from "@canopy/domain/computers";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./support/computers.ts";
import { githubFixture } from "./support/github.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("GitHub auth on a linked home", () => {
  let a: TestGateway;
  let b: TestGateway;
  let la: ReturnType<typeof linkedComputers>;
  let lb: ReturnType<typeof linkedComputers>;
  let fixture: ReturnType<typeof githubFixture>;
  const browser = { headers: { "canopy-github-client": randomBytes(32).toString("base64url") } };
  beforeAll(async () => {
    fixture = githubFixture();
    a = await startTestGateway({ role: "desktop", github: { ...fixture.options, clientId: "", slug: "" } });
    b = await startTestGateway({ role: "desktop", github: fixture.options });

    const link = (gw: TestGateway) =>
      linkedComputers({
        store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
        host: "127.0.0.1",
        heartbeatMs: 100,
        capabilities: ["presence", "unlink", REMOTE_THREADS, GITHUB_ACCOUNTS],
        serve: remoteServe(uiHandlers(gw.core), gw.core),
      });

    la = link(a);
    lb = link(b);
    a.core.computers = la;
    a.core.network = la.options.network;
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await la.start();
    await lb.start();
    const invitation = await a.api.createComputerPairing({});
    await b.api.linkComputer({ address: la.addresses[0]!, code: invitation.code });
    expect(
      await eventually(
        async () => (await a.api.getComputers({})).peers[0]?.status,
        (s) => s === "connected",
      ),
    ).toBe("connected");
  }, 60_000);
  afterAll(async () => {
    await la?.close();
    await lb?.close();
    await a?.close();
    await b?.close();
    fixture?.close();
  });

  test("A starts on B, but only B receives encrypted codes and tokens", async () => {
    const homeId = qualifyId(GITHUB_HOME, lb.hello().nodeId);
    expect((await a.api.listGitHubAccounts({})).configured).toBe(false);
    expect((await a.api.listGitHubAccounts({ homeId })).configured).toBe(true);
    fixture.mode("success");
    const started = await a.api.beginGitHubDeviceAuth({ homeId, clientRequestId: crypto.randomUUID() }, browser);
    expect(started.attempt!.id).toContain("~");
    fixture.advance(5000);
    await b.core.github.device.tick();
    const connected = await a.api.getGitHubDeviceAuth({ attemptId: started.attempt!.id }, browser);
    expect(connected.attempt!.state).toBe("connected");
    const catalogue = await a.api.listGitHubInstallations({ accountId: connected.attempt!.accountId });
    expect(catalogue.installations[0]!.login).toBe("organization-101");
    expect((await a.api.listGitHubAccounts({})).accounts).toHaveLength(0);
    expect((await b.api.listGitHubAccounts({})).accounts).toHaveLength(1);
    expect(
      await failure(b.api.getGitHubDeviceAuth({ attemptId: started.attempt!.id.split("~")[0]! }, browser)),
    ).toContain("not found");

    const output = inspect(
      [started, connected, catalogue, a.worker.commands, b.worker.commands, a.worker.configs, b.worker.configs],
      { depth: null },
    );

    for (const secret of fixture.secrets) expect(output.includes(secret)).toBe(false);
    await a.api.disconnectGitHubAccount({ accountId: connected.attempt!.accountId });
    expect((await b.api.listGitHubAccounts({})).accounts[0]!.status).toBe("disconnected");
  });

  test("the forwarded browser binding cannot be chosen by a public caller", async () => {
    const homeId = qualifyId(GITHUB_HOME, lb.hello().nodeId);

    const started = await a.api.beginGitHubDeviceAuth(
      { homeId, clientRequestId: crypto.randomUUID(), clientBinding: "a".repeat(64) },
      browser,
    );

    const other = { headers: { "canopy-github-client": randomBytes(32).toString("base64url") } };
    expect(
      await failure(
        a.api.cancelGitHubDeviceAuth({ attemptId: started.attempt!.id, clientBinding: "a".repeat(64) }, other),
      ),
    ).toContain("not found");
    const cancelled = await a.api.cancelGitHubDeviceAuth({ attemptId: started.attempt!.id }, browser);
    expect(cancelled.attempt!.state).toBe("cancelled");
    const count = fixture.polls;
    fixture.advance(5000);
    await b.core.github.device.tick();
    expect(fixture.polls).toBe(count);
  });
});
