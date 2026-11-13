import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { ComposerLocalStore, mergeComposerContent } from "./composer-drafts.ts";

test("drafts survive storage reload with citations, notes, uploads and explicit choices isolated by target", () => {
  const disk = new Map<string, string>();

  const store = new ComposerLocalStore(
    (key, raw) => {
      if (raw) disk.set(key, raw);
      else disk.delete(key);
    },
    () => crypto.randomUUID(),
  );

  const target = create(ui.ComposerDraftTargetSchema, { threadId: crypto.randomUUID() });
  const entry = store.make(target, "phone", "iPhone");

  if (!entry.draft) throw new Error("Missing draft");
  entry.draft.content = create(ui.ComposerDraftContentSchema, {
    text: "Prompt [quote]",
    model: "model",
    effort: "high",
    permissionMode: PermissionMode.ASK,
    provider: Provider.CODEX,
    clientRequestId: entry.draft.content?.clientRequestId ?? "",
    mentions: [{ name: "file-key", start: 0, end: 6 }],
    quotes: [{ text: "Quoted text", comment: "Keep this note", start: 7, end: 14 }],
  });
  entry.files = [
    create(ui.LocalComposerFileSchema, {
      key: "file-key",
      name: "image.png",
      kind: "image",
      attachment: { id: "uploaded-id" },
    }),
    create(ui.LocalComposerFileSchema, { key: "pending", name: "pending.txt", kind: "file" }),
  ];
  entry.pendingSend = new Uint8Array([1, 2, 3]);
  entry.mutationId = "durable-mutation";
  entry.publishedContent = "published";
  store.put(entry);
  store.flush();
  const touched = store.get(target)?.touchedAtMs;
  store.put(entry);
  expect(store.get(target)?.touchedAtMs).toBe(touched);

  const restored = new ComposerLocalStore(
    () => {},
    () => crypto.randomUUID(),
  );

  for (const [key, raw] of disk) restored.receive(key, raw);
  expect(restored.get(target)?.draft).toEqual(entry.draft);
  expect(restored.get(target)?.files).toEqual(entry.files);
  expect(restored.get(target)?.pendingSend).toEqual(entry.pendingSend);
  expect(restored.get(target)?.mutationId).toBe("durable-mutation");
  const other = create(ui.ComposerDraftTargetSchema, { projectId: "project", workspaceId: "workspace" });
  expect(restored.get(other)).toBeUndefined();
  const pending = store.make(other, "phone", "iPhone");
  pending.pendingCreate = new Uint8Array([4, 5]);
  store.put(pending);
  store.flush();

  for (const [key, raw] of disk) restored.receive(key, raw);
  expect(restored.get(other)?.pendingCreate).toEqual(pending.pendingCreate);
  restored.remove(other);
  restored.remove(target);
  restored.flush();
  expect(restored.list()).toEqual([]);
  store.dispose();
  restored.dispose();
});

test("two tabs persist independent targets and notify only the changed target", () => {
  const disk = new Map<string, string>();

  const persist = (key: string, raw: string | null) => {
    if (raw) disk.set(key, raw);
    else disk.delete(key);
  };

  const a = new ComposerLocalStore(persist, () => crypto.randomUUID());
  const b = new ComposerLocalStore(persist, () => crypto.randomUUID());
  const first = create(ui.ComposerDraftTargetSchema, { threadId: "first" });
  const second = create(ui.ComposerDraftTargetSchema, { threadId: "second" });
  let membership = 0;
  let other = 0;
  a.subscribe(() => membership++);
  a.subscribeKey(second, () => other++);
  const entry = a.make(first, "web", "Computer");

  if (!entry.draft?.content) throw new Error("Missing content");
  entry.draft.content.text = "A";
  a.put(entry);
  a.put(entry);
  entry.draft.content.text = "A edited";
  a.put(entry);
  const incoming = b.make(second, "web", "Computer");

  if (!incoming.draft?.content) throw new Error("Missing content");
  incoming.draft.content.text = "B";
  b.put(incoming);
  b.flush();
  a.flush();
  expect(disk.size).toBe(2);
  expect(membership).toBe(1);
  expect(other).toBe(0);

  for (const [key, raw] of disk) a.receive(key, raw);
  expect(a.get(second)?.draft?.content?.text).toBe("B");
  expect(other).toBe(1);
  b.remove(second);
  b.flush();
  expect(disk.size).toBe(1);
  a.dispose();
  b.dispose();
});

test("append preserves both prompts and ranges; incoming explicit choices fill unset local choices", () => {
  const local = create(ui.ComposerDraftContentSchema, { text: "Local", permissionMode: PermissionMode.ASK });

  const incoming = create(ui.ComposerDraftContentSchema, {
    text: "Incoming",
    model: "model",
    effort: "high",
    permissionMode: PermissionMode.FULL_AUTO,
    mentions: [{ name: "file-id", start: 0, end: 8 }],
    quotes: [{ text: "Quote", comment: "Note", start: 0, end: 8 }],
    attachments: [{ id: "file-id" }],
    clientRequestId: "stable-send",
  });

  const merged = mergeComposerContent(local, incoming);
  expect(merged.text).toBe("Local\n\nIncoming");
  expect(merged.mentions[0]?.start).toBe(7);
  expect(merged.quotes[0]?.start).toBe(7);
  expect(merged.quotes[0]?.comment).toBe("Note");
  expect(merged.model).toBe("model");
  expect(merged.permissionMode).toBe(PermissionMode.ASK);
  expect(merged.clientRequestId).toBe("stable-send");
});

test("scope disposal fences delayed writes and expiry/count bound the durable store", () => {
  let writes = 0;

  const store = new ComposerLocalStore(
    () => {
      writes++;
    },
    () => crypto.randomUUID(),
  );

  for (let index = 0; index < 101; index++) {
    const entry = store.make(create(ui.ComposerDraftTargetSchema, { threadId: String(index) }), "phone", "iPhone");

    if (entry.draft?.content) entry.draft.content.text = "Unsent";
    store.put(entry);
  }

  store.flush();
  expect(store.list()).toHaveLength(100);
  store.dispose();
  const previous = writes;
  store.flush();
  expect(writes).toBe(previous);
});
