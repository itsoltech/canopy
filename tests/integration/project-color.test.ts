import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Code, ConnectError } from "@connectrpc/connect";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

async function saveColorAndWatch(api: TestGateway["api"], projectId: string) {
  const abort = new AbortController();
  const watch = api.watchOverview({ includeSnapshot: true }, { signal: abort.signal, timeoutMs: 10_000 });

  try {
    for await (const { change } of watch) {
      if (change.case === "mobileSnapshot") {
        expect(change.value.overview?.projects.find((project) => project.id === projectId)?.color).toBe("");
        const { project } = await api.setProjectColor({ projectId, color: "  #AbC  " });
        expect(project).toMatchObject({ id: projectId, color: "#aabbcc" });
      }

      if (change.case === "project" && change.value.id === projectId && change.value.color === "#aabbcc") return;
    }

    throw new Error("Overview stream ended before publishing the saved project color");
  } finally {
    abort.abort();
  }
}

// Connect rejections need a direct handler on Bun (see support/gateway.ts).
function colorError(call: ReturnType<TestGateway["api"]["setProjectColor"]>) {
  return call.then(
    () => undefined,
    (error: Error) => ConnectError.from(error).code,
  );
}

describe.skipIf(!dockerAvailable)("project color", () => {
  let gateway: TestGateway | undefined;

  beforeAll(async () => {
    gateway = await startTestGateway();
  }, 60_000);
  afterAll(async () => gateway?.close(), 20_000);

  test("publishes the normalized color, preserves it after invalid input and restart, and resets to automatic", async () => {
    const previous = gateway!;
    const { api, pg, secretsKey, workerId, workerCredential } = previous;
    const { project } = await api.createProject({ name: "Project with a custom color" });
    const projectId = project!.id;

    const readColor = async () =>
      (await gateway!.api.getOverview({})).projects.find((row) => row.id === projectId)?.color;

    expect(project?.color).toBe("");
    await saveColorAndWatch(api, projectId);

    expect(await colorError(api.setProjectColor({ projectId, color: "#12x456" }))).toBe(Code.InvalidArgument);
    expect(await readColor()).toBe("#aabbcc");

    await previous.close(true);
    gateway = undefined;

    try {
      gateway = await startTestGateway({ storage: { pg, secretsKey, workerId, workerCredential } });
    } finally {
      if (!gateway) await pg.stop();
    }

    expect(await readColor()).toBe("#aabbcc");
    expect((await gateway.api.setProjectColor({ projectId, color: "" })).project?.color).toBe("");
    expect(await readColor()).toBe("");
  }, 45_000);

  test("rejects edits to another owner's project and the scratch project", async () => {
    const { api, runtime, userId } = gateway!;

    const foreign = await runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("project-color-other@localhost", "Other")),
    );

    const project = await runtime.runPromise(GatewayStore.use((store) => store.createProject(foreign, "Private")));
    const scratch = (await api.getOverview({})).projects.find((row) => row.kind === "scratch")!;

    for (const projectId of [project.id, scratch.id]) {
      expect(await colorError(api.setProjectColor({ projectId, color: "#123456" }))).toBe(Code.NotFound);
    }

    const privateProjects = await runtime.runPromise(GatewayStore.use((store) => store.listProjects(foreign)));
    const ownProjects = await runtime.runPromise(GatewayStore.use((store) => store.listProjects(userId)));

    expect(privateProjects.find((row) => row.id === project.id)?.color).toBe("");
    expect(ownProjects.find((row) => row.id === scratch.id)?.color).toBe("");
  });
});
