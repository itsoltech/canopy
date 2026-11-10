import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { nodeRef } from "@canopy/domain/computers";
import { ui, type CloneProgress } from "@canopy/contracts";
import { create } from "@bufbuild/protobuf";
import { linkedProjectFixture } from "./support/linked-projects.ts";
import { eventually } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("clone progress over linked computers", () => {
  const dir = tempDir("canopy-clone-linked-");
  let fixture: Awaited<ReturnType<typeof linkedProjectFixture>>;
  let workerId = "";
  const savedPath = process.env["PATH"];

  beforeAll(async () => {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    copyFileSync(new URL("./fixtures/clone-git.ts", import.meta.url), join(bin, "git"));
    chmodSync(join(bin, "git"), 0o755);
    process.env["CANOPY_FIXTURE_REAL_GIT"] = Bun.which("git")!;
    process.env["PATH"] = `${bin}:${savedPath}`;
    fixture = await linkedProjectFixture(dir, { cloneProgress: true });
    workerId = `${fixture.b.workerId}~${nodeRef(fixture.lb.hello().nodeId)}`;
  }, 90_000);

  afterAll(async () => {
    await fixture?.close();
    process.env["PATH"] = savedPath;
    delete process.env["CANOPY_FIXTURE_REAL_GIT"];
  }, 30_000);

  const request = (name: string) =>
    create(ui.AddProjectRequestSchema, {
      workerId,
      source: { case: "clone", value: { parentPath: fixture.b.dir, name, url: `file://${fixture.b.origin}` } },
    });

  test("streams progress and safe logs from the home, then returns its qualified workspace", async () => {
    const events: CloneProgress[] = [];
    let result: ui.AddProjectResponse | undefined;

    for await (const update of fixture.a.gw.api.cloneProject(request("fixture-logged-linked"))) {
      if (update.progress) events.push(update.progress);

      if (update.result) result = update.result;
    }

    expect(result?.workspace?.workerId).toBe(workerId);
    expect(result?.workspace?.rootPath).toBe(join(fixture.b.dir, "fixture-logged-linked"));
    expect(result?.project?.nodeId).toBe(fixture.lb.hello().nodeId);
    const frames = events.filter((p) => p.sequence > 0);
    expect(frames.length).toBeGreaterThan(4);
    expect(frames.map((p) => p.sequence)).toEqual(frames.map((_, index) => index + 1));
    expect(frames.some((p) => p.phase === "Receiving objects" && p.percent! > 0)).toBe(true);
    expect(JSON.stringify(events)).not.toContain("fixture-url-secret");
    expect(JSON.stringify(events)).not.toContain("fixture-header-secret");
    const overview = await fixture.a.gw.api.getOverview({});
    expect(overview.workers.find((w) => w.id === workerId)?.cloneProgress).toBe(true);
  }, 20_000);

  test("remote cancellation reaches the worker and cleans its partial clone", async () => {
    const abort = new AbortController();

    const running = (async () => {
      try {
        for await (const update of fixture.a.gw.api.cloneProject(request("fixture-cancel-linked"), {
          signal: abort.signal,
        })) {
          void update;
        }
      } catch {
        /* expected client cancellation */
      }
    })();

    const path = join(fixture.b.dir, "fixture-cancel-linked");
    const pidFile = join(path, "git.pid");
    await eventually(async () => existsSync(pidFile), Boolean);
    const pid = Number(readFileSync(pidFile, "utf8"));
    abort.abort();
    await running;
    expect(
      await eventually(
        async () => existsSync(path),
        (exists) => !exists,
      ),
    ).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(
      (await fixture.b.gw.api.getOverview({})).projects.flatMap((p) => p.workspaces).some((w) => w.rootPath === path),
    ).toBe(false);
  }, 15_000);
});
