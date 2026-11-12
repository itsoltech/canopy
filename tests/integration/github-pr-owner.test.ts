import { test, expect } from "bun:test";
import { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { serviceTokenAuth, uiRoutes } from "@canopy/gateway/api";
import { startGrpcServer } from "@canopy/transport";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { connectGitHub, githubPrFixture, githubThread } from "./support/github-pr.ts";
import { SERVICE_TOKEN, startTestGateway } from "./support/gateway.ts";

test.skipIf(!dockerAvailable)(
  "PR gRPC rejects foreign owner identities before cache lookup or link mutation",
  async () => {
    const fixture = githubPrFixture();
    const gw = await startTestGateway({ github: fixture.options });

    const user = await gw.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("pr-owner@example.test", "Other owner")),
    );

    const core = new GatewayCore({
      runtime: gw.runtime,
      userId: user,
      instanceId: "pr-owner",
      sshSecretsKey: gw.secretsKey,
      github: fixture.options,
    });

    const grpc = await startGrpcServer({
      routes: uiRoutes(core),
      interceptors: [serviceTokenAuth(SERVICE_TOKEN)],
      host: "127.0.0.1",
      port: 0,
    });

    const foreign = createClient(
      ui.GatewayService,
      createGrpcTransport({
        baseUrl: grpc.url,
        interceptors: [
          (next) => (request) => {
            request.header.set("authorization", `Bearer ${SERVICE_TOKEN}`);

            return next(request);
          },
        ],
      }),
    );

    try {
      const account = await connectGitHub(gw, fixture);
      const thread = await githubThread(gw);
      await gw.api.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account });

      const list = await gw.api.linkThreadPullRequest({
        threadId: thread,
        url: "https://github.com/itsoltech/canopy/pull/42",
      });

      const pr = list.links[0]!.summary!.ref!.id;
      const calls = fixture.calls;

      for (const use of [
        () => foreign.getPullRequest({ pullRequestId: pr }),
        () => foreign.refreshPullRequest({ pullRequestId: pr }),
        () => foreign.listThreadPullRequests({ threadId: thread }),
        () => foreign.listRepositoryPullRequests({ threadId: thread }),
        () => foreign.linkThreadPullRequest({ threadId: thread, url: "https://github.com/itsoltech/canopy/pull/42" }),
        () => foreign.unlinkThreadPullRequest({ threadId: thread, pullRequestId: pr, expectedRevision: list.revision }),
        () => foreign.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account }),
      ])
        expect(
          await use().then(
            () => 0,
            (e) => ConnectError.from(e).code,
          ),
        ).toBe(Code.NotFound);
      expect(
        (await foreign.getGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy" })).candidates,
      ).toHaveLength(0);
      expect(fixture.calls).toBe(calls);
      expect((await gw.api.listThreadPullRequests({ threadId: thread })).links).toHaveLength(1);
    } finally {
      await core.stopSweep();
      await grpc.close();
      await gw.close();
      fixture.close();
    }
  },
  60_000,
);
