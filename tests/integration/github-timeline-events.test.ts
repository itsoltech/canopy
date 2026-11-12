import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { dockerAvailable } from "@canopy/db/testing";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";
import { linkedRead, readFixture } from "./support/github-read.ts";
import { timelineActor, timelineDate, timelineEventPage } from "./support/github-timeline.ts";

describe.skipIf(!dockerAvailable)("GitHub timeline event projection", () => {
  const fixture = readFixture((query, variables) =>
    query.includes("query CanopyTimeline") ? Response.json(timelineEventPage(!!variables["before"])) : undefined,
  );

  let gw: TestGateway;
  let pr: string;

  beforeAll(async () => {
    gw = await startTestGateway({ github: fixture.options });
    ({ pr } = await linkedRead(gw, fixture));
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  test("hides mention and subscription noise without losing older activity or payload identity", async () => {
    const latest = await gw.api.listPullRequestTimeline({ pullRequestId: pr });
    expect(latest.items).toEqual([]);
    expect(latest.page?.nextCursor).toBeTruthy();

    const older = await gw.api.listPullRequestTimeline({ pullRequestId: pr, cursor: latest.page!.nextCursor });
    expect(older.items.map((item) => item.content.value?.id)).toEqual(["UNDATED", "LABEL"]);
    const label = older.items.find((item) => item.content.value?.id === "LABEL")?.content.value;
    expect(label?.author).toBe(timelineActor.login);
    expect(label?.body).toBe("security");
    expect(label?.createdAt).toEqual(timestampFromDate(new Date(timelineDate)));
    const undated = older.items.find((item) => item.content.value?.id === "UNDATED")?.content.value;
    expect(undated?.author).toBe(timelineActor.login);
    expect(undated?.body).toBe("Keep this comment");
    expect(undated?.createdAt).toBeUndefined();
    expect(older.page?.nextCursor).toBe("");
  });
});
