import { beforeAll, afterAll, describe, test, expect } from "bun:test";
import { TurnOutcome } from "@canopy/contracts";
import { ConnectError } from "@connectrpc/connect";
import { dockerAvailable } from "@canopy/db/testing";
import { draftPullRequest } from "@canopy/domain/github-agent-draft";
import { startTestGateway, eventually, type TestGateway } from "./support/gateway.ts";
import { linkedRead } from "./support/github-read.ts";
import { lifecycleFixture } from "./support/github-lifecycle.ts";
import { draftAnswer } from "./support/github-agent-draft.ts";

const failure = (pending: Promise<object>) =>
  pending.then(
    () => "succeeded",
    (cause) => ConnectError.from(cause).rawMessage,
  );

describe.skipIf(!dockerAvailable)("User-requested PR draft through the thread transport", () => {
  const fixture = lifecycleFixture();
  let gw: TestGateway, thread: string;

  beforeAll(async () => {
    gw = await startTestGateway({
      github: fixture.options,
      worker: { hello: { capabilities: ["git_pr_context_v1"] } },
    });
    await gw.core.githubDetection.stop();
    gw.worker.handlers.set("readGitPrContext", (_command, reply) =>
      reply(true, {
        gitPrContext: {
          branch: fixture.state.branch,
          headOid: fixture.state.head,
          pushRemote: "origin",
          pushRef: fixture.state.branch,
          remotes: [
            {
              name: "origin",
              fetchRepositories: ["github.com/itsoltech/canopy"],
              pushRepositories: ["github.com/itsoltech/canopy"],
            },
          ],
        },
      }),
    );
    ({ thread } = await linkedRead(gw, fixture));
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  const context = () => gw.api.preparePullRequestDraftContext({ threadId: thread, headSha: fixture.state.head });

  test("only the matching completed answer fills text; extra model fields cannot select or create a PR", async () => {
    const body = "<script>untrusted proposal</script>\n\nMarkdown body";

    const inputs = draftAnswer(
      gw,
      JSON.stringify({ title: "Draft title", body, action: "create_pr", accountId: "foreign" }),
    );

    const prepared = await context();
    expect(inputs).toEqual([]);
    const id = crypto.randomUUID();
    const result = await draftPullRequest(gw.api, thread, prepared, id, AbortSignal.timeout(10_000));
    expect(result).toEqual({ title: "Draft title", body });
    expect(inputs.length).toBe(1);
    expect(inputs[0]).toContain('"title" and "body"');
    expect(fixture.state.creates).toBe(0);
    expect(await draftPullRequest(gw.api, thread, prepared, id, AbortSignal.timeout(10_000))).toEqual(result);
    expect(inputs.length).toBe(1);
  }, 30_000);

  test("an interrupted or malformed answer never replaces fields with a previous turn's draft", async () => {
    const prepared = await context();
    draftAnswer(gw, '{"title":"Interrupted","body":"Do not import"}', TurnOutcome.INTERRUPTED);
    expect(
      await failure(draftPullRequest(gw.api, thread, prepared, crypto.randomUUID(), AbortSignal.timeout(10_000))),
    ).toContain("Draft stopped");
    draftAnswer(gw, "Not a JSON draft");
    expect(
      await failure(
        draftPullRequest(gw.api, thread, await context(), crypto.randomUUID(), AbortSignal.timeout(10_000)),
      ),
    ).toContain("JSON");
    expect(fixture.state.creates).toBe(0);
  }, 30_000);

  test("a lost send response is not retried or replayed", async () => {
    const inputs = draftAnswer(gw, '{"title":"Lost response","body":"Check the thread"}');

    const api = {
      sendMessage: async (...args: Parameters<typeof gw.api.sendMessage>) => {
        await gw.api.sendMessage(...args);
        throw new Error("Fixture lost response");
      },
      watchThread: gw.api.watchThread,
    };

    expect(
      await failure(draftPullRequest(api, thread, await context(), crypto.randomUUID(), AbortSignal.timeout(10_000))),
    ).toBe("Fixture lost response");
    await eventually(
      async () => inputs.length,
      (length) => length === 1,
    );
    expect(inputs.length).toBe(1);
    expect(fixture.state.creates).toBe(0);
  }, 30_000);
});
