import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@open-agents/contracts";
import { ArchivedThreadsPager } from "./archived-threads.ts";

const page = (ids: string[], nextPageToken = "", totalCount = 55) => create(ui.ListArchivedThreadsResponseSchema, {
  threads: ids.map((id) => ({ id, status: "archived" })), nextPageToken, totalCount,
});
const filter = { projectIds: [], query: "" };
describe("archived paging", () => {
  test("collapsed only asks for count; expanded loads first page, more appends and deduplicates", async () => {
    const calls: { countOnly: boolean; pageToken: string }[] = [];
    const pager = new ArchivedThreadsPager(async (request) => {
      calls.push(request);
      return request.countOnly ? page([]) : request.pageToken ? page(["b", "c"]) : page(["a", "b"], "next");
    }, () => {});
    await pager.refresh(filter, false);
    expect(pager.state.threads).toEqual([]);
    expect(pager.state.totalCount).toBe(55);
    await pager.refresh(filter, true);
    await Promise.all([pager.more(), pager.more()]);
    expect(pager.state.threads.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(calls.map((r) => [r.countOnly, r.pageToken])).toEqual([[true, ""], [false, ""], [false, "next"]]);
    await pager.more();
    expect(calls).toHaveLength(3);
    await pager.refresh(filter, true);
    expect(calls.slice(-2).map((r) => r.pageToken)).toEqual(["", "next"]); // live refresh preserves loaded depth
  });

  test("old responses cannot overwrite new filters, collapse or a disposed component", async () => {
    const pending: ((value: ui.ListArchivedThreadsResponse) => void)[] = [];
    const pager = new ArchivedThreadsPager(() => new Promise((resolve) => pending.push(resolve)), () => {});
    const first = pager.refresh(filter, true);
    const second = pager.refresh({ projectIds: ["b"], query: "needle" }, true);
    pending[1]!(page(["new"])); await second;
    pending[0]!(page(["old"])); await first;
    expect(pager.state.threads.map((t) => t.id)).toEqual(["new"]);
    const third = pager.refresh(filter, true);
    const collapsed = pager.refresh(filter, false);
    pending[3]!(page([], "", 3)); await collapsed;
    pending[2]!(page(["stale"])); await third;
    expect(pager.state.threads).toEqual([]);
    expect(pager.state.totalCount).toBe(3);
    const final = pager.refresh(filter, true); pager.dispose();
    pending[4]!(page(["late"])); await final;
    expect(pager.state.threads).toEqual([]);
  });

  test("load-more failure retains rows and cursor for retry; a filter change resets them", async () => {
    let fail = true;
    const pager = new ArchivedThreadsPager(async (request) => {
      if (request.pageToken && fail) throw new Error("offline");
      return request.pageToken ? page(["b"]) : page(["a"], "next");
    }, () => {});
    await pager.refresh(filter, true); await pager.more();
    expect([pager.state.error, pager.state.nextPageToken, pager.state.threads.length]).toEqual(["offline", "next", 1]);
    fail = false; await pager.more();
    expect(pager.state.threads.map((t) => t.id)).toEqual(["a", "b"]);
    await pager.refresh({ ...filter, query: "new" }, true);
    expect(pager.state.threads.map((t) => t.id)).toEqual(["a"]);
  });
});
