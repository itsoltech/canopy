import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Code, ConnectError } from "@connectrpc/connect";
import sharp from "sharp";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

const image = (width = 72, height = width) =>
  sharp({ create: { width, height, channels: 4, background: "#137c7480" } });

async function setAndWatchImage(api: TestGateway["api"], projectId: string, bytes: Uint8Array, previous: string) {
  const abort = new AbortController();
  const watch = api.watchOverview({ includeSnapshot: true }, { signal: abort.signal, timeoutMs: 10_000 });
  let expected: string | undefined;

  try {
    for await (const { change } of watch) {
      if (change.case === "mobileSnapshot") {
        expect(change.value.overview?.projects.find((project) => project.id === projectId)?.imageBase64).toBe(previous);
        const { project } = await api.setProjectImage({ projectId, image: bytes });
        expect(project).toMatchObject({ id: projectId, color: "#aabbcc" });
        expected = project!.imageBase64;
        expect(Boolean(expected)).toBe(bytes.length > 0);
      }

      if (change.case === "project" && change.value.id === projectId && change.value.imageBase64 === expected)
        return expected;
    }

    throw new Error("Overview stream ended before publishing the project image change");
  } finally {
    abort.abort();
  }
}

// Connect rejections need a direct handler on Bun (see support/gateway.ts).
function imageError(call: ReturnType<TestGateway["api"]["setProjectImage"]>) {
  return call.then(
    () => undefined,
    (error: Error) => ConnectError.from(error).code,
  );
}

describe.skipIf(!dockerAvailable)("project image", () => {
  let gateway: TestGateway | undefined;

  beforeAll(async () => {
    gateway = await startTestGateway();
  }, 60_000);
  afterAll(async () => gateway?.close(), 20_000);

  test("publishes a bounded transparent PNG, persists it across restart and publishes removal", async () => {
    const previous = gateway!;
    const { api, pg, secretsKey, workerId, workerCredential } = previous;
    const { project } = await api.createProject({ name: "Project with a custom image" });
    const projectId = project!.id;
    await api.setProjectColor({ projectId, color: "#abc" });

    const upload = await image().withMetadata({ density: 245, orientation: 6 }).png().toBuffer();
    const base64 = await setAndWatchImage(api, projectId, upload, "");
    expect(base64.length).toBeLessThanOrEqual(24 * 1024);
    const thumbnail = sharp(Buffer.from(base64, "base64"));
    const metadata = await thumbnail.metadata();
    expect(metadata).toMatchObject({ format: "png", width: 128, height: 128, isPalette: true, hasAlpha: true });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.density).toBeUndefined();
    const alpha = await thumbnail.extractChannel("alpha").raw().toBuffer();
    expect(alpha.every((value) => value === 128)).toBe(true);

    await previous.close(true);
    gateway = undefined;

    try {
      gateway = await startTestGateway({ storage: { pg, secretsKey, workerId, workerCredential } });
    } finally {
      if (!gateway) await pg.stop();
    }

    expect(await setAndWatchImage(gateway.api, projectId, new Uint8Array(), base64)).toBe("");
    expect((await gateway.api.getOverview({})).projects.find((p) => p.id === projectId)).toMatchObject({
      imageBase64: "",
      color: "#aabbcc",
    });
  }, 45_000);

  test("accepts JPEG and WebP and keeps the saved image after invalid uploads", async () => {
    const { api } = gateway!;
    const { project } = await api.createProject({ name: "Image upload validation" });
    const projectId = project!.id;
    const jpeg = await image().jpeg().toBuffer();
    // The first frame is transparent. The second frame is opaque.
    const frames = Buffer.alloc(16 * 16 * 4 * 2, 255);
    frames.fill(128, 0, frames.length / 2);

    const webp = await sharp(frames, { raw: { width: 16, height: 32, pageHeight: 16, channels: 4 } })
      .webp({ delay: [100, 100] })
      .toBuffer();

    const { project: withJpeg } = await api.setProjectImage({ projectId, image: jpeg });
    const { project: withWebp } = await api.setProjectImage({ projectId, image: webp });

    for (const saved of [withJpeg, withWebp])
      expect(await sharp(Buffer.from(saved!.imageBase64, "base64")).metadata()).toMatchObject({
        format: "png",
        width: 128,
        height: 128,
      });

    expect((await sharp(Buffer.from(withWebp!.imageBase64, "base64")).metadata()).hasAlpha).toBe(true);

    const png = await image().png().toBuffer();

    for (const rejected of [
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"/>'),
      await image(72, 64).png().toBuffer(),
      png.subarray(0, 48),
      new Uint8Array(10 * 1024 ** 2 + 1),
    ])
      expect(await imageError(api.setProjectImage({ projectId, image: rejected }))).toBe(Code.InvalidArgument);

    expect((await api.getOverview({})).projects.find((p) => p.id === projectId)?.imageBase64).toBe(
      withWebp!.imageBase64,
    );
  }, 20_000);

  test("rejects writes to private, scratch and archived projects", async () => {
    const { api, runtime } = gateway!;

    const foreign = await runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("project-image-other@localhost", "Other")),
    );

    const project = await runtime.runPromise(GatewayStore.use((store) => store.createProject(foreign, "Private")));
    const scratch = (await api.getOverview({})).projects.find((row) => row.kind === "scratch")!;
    const { project: archived } = await api.createProject({ name: "Archived image setting" });
    await api.archiveProject({ projectId: archived!.id });
    const png = await image().png().toBuffer();

    for (const projectId of [project.id, scratch.id, archived!.id])
      expect(await imageError(api.setProjectImage({ projectId, image: png }))).toBe(Code.NotFound);

    const privateProjects = await runtime.runPromise(GatewayStore.use((store) => store.listProjects(foreign)));
    expect(privateProjects.find((row) => row.id === project.id)?.imageBase64).toBe("");
  });
});
