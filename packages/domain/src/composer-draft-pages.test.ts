import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { loadComposerDraftPages } from "./composer-draft-pages.ts";
import { composerTargetKey, matchesComposerTarget } from "./composer-drafts.ts";

test("composer counts include matching drafts beyond the first page and retain move receipts", async () => {
  const target = create(ui.ComposerDraftTargetSchema, {
    projectId: "project",
    workspaceId: "workspace",
    parentThreadId: "parent",
  });

  const pages = [
    create(ui.ComposerDraftPageSchema, {
      drafts: Array.from({ length: 20 }, (_, index) => ({ id: String(index), target: { threadId: "other" } })),
      nextPageToken: "second",
      moves: [{ id: "moved", deviceName: "Mac", sourceRevision: 2n }],
      threadIds: ["other"],
    }),
    create(ui.ComposerDraftPageSchema, {
      drafts: [
        { id: "matching", target },
        { id: "wrong-parent", target: { ...target, parentThreadId: "other" } },
      ],
      moves: [{ id: "later-move", sourceRevision: 3n }],
    }),
  ];

  const page = await loadComposerDraftPages(
    async (token) => pages[token ? 1 : 0] ?? create(ui.ComposerDraftPageSchema),
  );
  expect(
    page.drafts.filter((row) => matchesComposerTarget(row.target, composerTargetKey(target))).map((row) => row.id),
  ).toEqual(["matching"]);
  expect(page.moves.map((move) => move.id)).toEqual(["moved", "later-move"]);
  expect(page.threadIds).toEqual(["other"]);
  expect(page.nextPageToken).toBe("");
});

test("draft pagination stays bounded across changes and repeated cursors", async () => {
  const page = await loadComposerDraftPages(async (token) => {
    const offset = Number(token || 0);

    return create(ui.ComposerDraftPageSchema, {
      drafts: Array.from({ length: 20 }, (_, index) => ({ id: String(offset + index) })),
      nextPageToken: String(offset + 20),
    });
  });

  expect(page.drafts).toHaveLength(100);
  const repeated = await loadComposerDraftPages(async () =>
    create(ui.ComposerDraftPageSchema, { drafts: [{ id: "same" }], nextPageToken: "repeat" }),
  );
  expect(repeated.drafts.map((row) => row.id)).toEqual(["same"]);
});
