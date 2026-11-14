import { create, clone, fromBinary, toBinary, toJsonString } from "@bufbuild/protobuf";
import { ui, type Mention } from "@canopy/contracts";
import type { AttachmentLimits } from "@canopy/domain";
import {
  ComposerLocalStore,
  composerTargetKey,
  hasComposerContent,
  mergeComposerContent,
} from "@canopy/domain/composer-drafts";
import { AttachmentDraft, type DraftFile } from "#lib/features/attachments/draft.svelte.ts";
import { useQuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";
import { saveDraft, deleteDraft, continueDraft, listDrafts } from "./api.ts";
import { trimValue } from "#lib/features/mentions/editor.ts";
import { toWire, type QuoteDraft } from "#lib/features/quotes/quote.ts";
import { HttpError } from "#lib/shared/http.ts";
import { recoverDraft } from "./recovery.ts";

export interface ComposerSnapshot {
  text: string;
  mentions: Mention[];
  files: DraftFile[];
  quotes: readonly QuoteDraft[];
  choices?: WebComposerDraft["choices"];
}

/** Local snapshot/restore is independent of gateway handoff (`apply`) and its revision. */
export class WebComposerDraft {
  text = $state("");
  mentions = $state<Mention[]>([]);
  choices = $state<
    Pick<ui.ComposerDraftContent, "model" | "effort" | "permissionMode" | "provider" | "providerProfileId">
  >({ provider: 0, providerProfileId: "" });
  error = $state("");
  moved = $state("");
  pendingSend = $state<ui.SendMessageRequest>();
  pendingForm = $state("");
  preparing = $state(false);
  reconciling = $state(false);
  deliveryChecked = $state(false);
  publishedAtMs = $state(0n);
  pendingAbort: (() => void) | undefined;
  readonly files: AttachmentDraft;
  readonly quoteKey: string;
  #entry: ui.LocalComposerDraft;
  #saving: Promise<ui.ComposerDraft> | undefined;
  #published = "";
  #active = false;
  retired = false;
  #mutation: string = crypto.randomUUID();
  constructor(
    entry: ui.LocalComposerDraft,
    limits: () => AttachmentLimits,
    readonly local: ComposerLocalStore,
  ) {
    this.#entry = entry;
    this.#mutation = entry.mutationId || crypto.randomUUID();
    this.#published = entry.publishedContent;
    this.pendingSend = entry.pendingSend.length
      ? fromBinary(ui.SendMessageRequestSchema, entry.pendingSend)
      : undefined;
    this.pendingForm = entry.pendingForm;
    this.quoteKey =
      entry.draft?.target?.threadId ||
      `composer:${composerTargetKey(entry.draft?.target ?? create(ui.ComposerDraftTargetSchema))}`;
    this.files = new AttachmentDraft(limits, { onUploaded: () => this.persist() });
    this.#restore(entry);
  }
  #restore(entry: ui.LocalComposerDraft) {
    this.publishedAtMs = entry.draft?.updatedAtMs ?? 0n;
    const content = entry.draft?.content;
    this.text = content?.text ?? "";
    this.mentions = content?.mentions ?? [];
    this.choices = {
      model: content?.model,
      effort: content?.effort,
      permissionMode: content?.permissionMode,
      provider: content?.provider ?? 0,
      providerProfileId: content?.providerProfileId ?? "",
    };
    this.files.files = entry.files.map((f) => ({
      key: f.key,
      name: f.name,
      size: Number(f.size),
      image: f.kind === "image",
      video: f.kind === "video",
      contextScope: f.contextScope || undefined,
      localUrl: undefined,
      status: f.attachment ? "ready" : "failed",
      progress: f.attachment ? 1 : 0,
      error: f.attachment ? undefined : "Upload interrupted. Remove this file and add it again.",
      attachment: f.attachment,
    }));
    this.files.place(this.mentions);
  }
  activate() {
    if (this.#active) return;
    this.#active = true;
    const quotes = this.#entry.draft?.content?.quotes;

    if (quotes?.length) useQuoteDrafts().restore(this.quoteKey, quotes);
  }
  get requestId() {
    return this.#entry.draft?.content?.clientRequestId ?? "";
  }
  get id() {
    return this.#entry.draft?.id ?? "";
  }
  get revision() {
    return this.#entry.draft?.revision ?? 0n;
  }
  fork() {
    const draft = this.#entry.draft;

    if (!draft) return;
    draft.id = crypto.randomUUID();
    draft.revision = 0n;
    draft.updatedAtMs = 0n;
    this.publishedAtMs = 0n;
    draft.takenByDeviceId = "";
    draft.takenByDeviceName = "";

    if (draft.content) draft.content.clientRequestId = crypto.randomUUID();
    this.#published = "";
    this.#mutation = crypto.randomUUID();
    this.persist();
  }
  get locked() {
    return this.preparing || Boolean(this.pendingSend || this.pendingForm);
  }
  acceptMove(move: ui.ComposerDraftMove) {
    if (move.id !== this.id || this.revision > move.sourceRevision || this.locked) return;
    this.activate();

    const unchanged =
      this.revision === move.sourceRevision &&
      !this.files.blocker &&
      this.#published === toJsonString(ui.ComposerDraftContentSchema, this.content(true));

    if (unchanged) this.clear();
    else this.fork();
    this.moved = unchanged
      ? `Draft taken over on ${move.deviceName}`
      : `Draft taken over on ${move.deviceName}. Your edits are kept here.`;
  }
  reconcile() {
    return recoverDraft(this);
  }
  snapshot(): ComposerSnapshot {
    if (this.files.blocker) throw new Error(this.files.blocker);
    this.activate();

    return {
      text: this.text,
      mentions: this.mentions.map((m) => ({ ...m })),
      files: this.files.attached.map((f) => ({ ...f, localUrl: undefined })),
      quotes: useQuoteDrafts()
        .list(this.quoteKey)
        .map((q) => ({ ...q })),
      choices: { ...this.choices },
    };
  }
  restore(snapshot: ComposerSnapshot) {
    if (this.locked) throw new Error("Retry the pending message before restoring a draft.");

    if (this.files.blocker) throw new Error(this.files.blocker);

    if (snapshot.files.some((f) => !f.attachment || f.status !== "ready"))
      throw new Error("Wait for uploads, or remove the files that could not be attached.");
    // Hydrate once before replacement so a later mount cannot restore stale citations over an edit.
    this.activate();
    this.files.clear();
    this.files.files = snapshot.files.map((f) => ({ ...f, localUrl: undefined }));
    this.text = snapshot.text;
    this.mentions = snapshot.mentions.map((m) => ({ ...m }));
    useQuoteDrafts().place(
      this.quoteKey,
      snapshot.quotes.map((q) => ({ ...q })),
    );

    if (snapshot.choices) this.choices = { ...snapshot.choices };

    // A local swap changes message identity, never the gateway CAS revision.
    if (this.#entry.draft?.content) this.#entry.draft.content.clientRequestId = crypto.randomUUID();
    this.#mutation = crypto.randomUUID();
    this.persist();
  }
  outgoing() {
    const trimmed = trimValue({
      text: this.text,
      mentions: this.mentions,
      quotes: useQuoteDrafts().list(this.quoteKey),
    });

    return create(ui.ComposerDraftContentSchema, {
      ...this.content(true),
      text: trimmed.text,
      mentions: this.files.wire(trimmed.mentions),
      quotes: (trimmed.quotes ?? []).map((q) => create(ui.QuoteSchema, toWire(q))),
    });
  }
  content(wire = false) {
    return create(ui.ComposerDraftContentSchema, {
      ...this.choices,
      text: this.text,
      mentions: wire ? this.files.wire(this.mentions) : this.mentions,
      quotes: useQuoteDrafts()
        .wire(this.quoteKey)
        .map((q) => create(ui.QuoteSchema, q)),
      attachments: this.files.attached.flatMap((f) => f.attachment ?? []),
      clientRequestId: this.requestId,
    });
  }
  persist() {
    if (this.retired) return;
    this.files.place(this.mentions);
    const draft = this.#entry.draft;

    if (!draft) return;
    this.#entry = create(ui.LocalComposerDraftSchema, {
      mutationId: this.#mutation,
      publishedContent: this.#published,
      pendingSend: this.pendingSend ? toBinary(ui.SendMessageRequestSchema, this.pendingSend) : new Uint8Array(),
      pendingForm: this.pendingForm,
      draft: { ...draft, content: this.content() },
      files: this.files.attached.map((f) => ({
        key: f.key,
        name: f.name,
        size: BigInt(f.size),
        kind: f.image ? "image" : f.video ? "video" : "file",
        attachment: f.attachment,
        contextScope: f.contextScope ?? "",
      })),
    });
    this.local.put(this.#entry);
  }
  async publish(): Promise<ui.ComposerDraft> {
    if (this.retired) throw new Error("Draft changed in another tab");

    if (this.pendingSend || this.pendingForm)
      throw new Error("Retry the pending message before handing off this draft.");

    if (this.local.closed) throw new Error("Gateway changed");

    if (this.#saving) {
      await this.#saving;

      return this.publish();
    }

    this.persist();
    const draft = this.#entry.draft;

    if (!draft) throw new Error("Draft unavailable");

    if (this.files.blocker) throw new Error(this.files.blocker);
    const outgoing = create(ui.ComposerDraftSchema, { ...draft, content: this.content(true) });

    if (!hasComposerContent(outgoing.content)) {
      if (draft.revision) {
        try {
          await deleteDraft(draft, draft.deviceId);
        } catch (cause) {
          if (!(cause instanceof HttpError) || ![404, 409].includes(cause.status)) throw cause;
        }

        this.clear();
      }

      return outgoing;
    }

    const serialized = toJsonString(
      ui.ComposerDraftContentSchema,
      outgoing.content ?? create(ui.ComposerDraftContentSchema),
    );

    if (this.#published === serialized && draft.revision) return outgoing;
    await this.local.checkpoint();
    this.#saving = saveDraft(outgoing, this.#mutation);
    let saved: ui.ComposerDraft;

    try {
      saved = await this.#saving;

      if (this.retired || this.id !== outgoing.id) return saved;
      this.publishedAtMs = saved.updatedAtMs;
      this.#entry = create(ui.LocalComposerDraftSchema, {
        ...this.#entry,
        draft: { ...saved, content: this.content() },
      });
      this.#published = toJsonString(
        ui.ComposerDraftContentSchema,
        saved.content ?? create(ui.ComposerDraftContentSchema),
      );
      this.#mutation = crypto.randomUUID();
      this.error = "";
      this.persist();
    } catch (cause) {
      if (this.retired || this.id !== outgoing.id || this.locked) return outgoing;

      if (cause instanceof HttpError && [404, 409].includes(cause.status)) {
        const page = await listDrafts(draft.deviceId, "", "", [outgoing.id]);
        const move = page.moves.find((row) => row.id === outgoing.id);

        if (move) {
          this.acceptMove(move);

          return outgoing;
        }

        this.fork();
        this.#saving = undefined;

        return this.publish();
      }

      if (cause instanceof HttpError && cause.status === 426) {
        this.error = cause.message;
        throw cause;
      }

      this.error = "Could not hand off this draft. Check the connection, then retry.";
      throw new Error(this.error);
    } finally {
      this.#saving = undefined;
    }

    return saved;
  }
  async publishForSend() {
    this.persist();

    return this.#entry.draft;
  }
  async beginSend(request: ui.SendMessageRequest) {
    this.deliveryChecked = false;
    this.pendingSend = request;
    this.persist();
    await this.local.checkpoint();
  }
  async beginForm(form: FormData) {
    this.deliveryChecked = false;
    this.pendingForm = new URLSearchParams([...form].map(([key, value]) => [key, String(value)])).toString();
    this.persist();
    await this.local.checkpoint();
  }
  cancelSend(fork = false, discardPending = false) {
    if (fork) this.pendingAbort?.();
    const draft = this.#entry.draft;

    if (discardPending && (this.pendingSend || this.pendingForm) && draft)
      void deleteDraft(draft, draft.deviceId).catch(() => {});
    this.pendingSend = undefined;
    this.pendingForm = "";

    if (fork) this.fork();
    this.persist();
  }
  async take(incoming: ui.ComposerDraft, replace = false) {
    if (this.locked || this.files.blocker)
      throw new Error("Retry the pending message or wait for uploads, then retry.");
    const device = this.#entry.draft;

    if (!device || this.local.closed) throw new Error("Draft unavailable");
    this.preparing = true;

    try {
      const claimed = await continueDraft(incoming, device.deviceId, device.deviceName, crypto.randomUUID());
      this.preparing = false;
      this.apply(claimed, replace);
      this.preparing = true;
      await this.local.checkpoint();
      await this.publish();
    } finally {
      this.preparing = false;
    }
  }
  apply(incoming: ui.ComposerDraft, replace = false) {
    if (this.locked) throw new Error("Retry the pending message before continuing a draft.");

    if (this.id === incoming.id && this.revision >= incoming.revision) return;

    if (this.files.blocker) throw new Error(this.files.blocker);

    const content =
      !replace && hasComposerContent(this.content()) && incoming.content
        ? mergeComposerContent(this.content(true), incoming.content)
        : incoming.content;

    const draft = create(ui.ComposerDraftSchema, {
      ...incoming,
      deviceId: incoming.takenByDeviceId,
      deviceName: incoming.takenByDeviceName,
      content,
    });

    const entry = create(ui.LocalComposerDraftSchema, {
      draft,
      files: (content?.attachments ?? []).map((a) => ({
        key: a.id,
        name: a.name,
        size: a.sizeBytes,
        kind: a.kind,
        attachment: a,
      })),
    });

    this.files.clear();
    this.#published = "";
    this.#mutation = crypto.randomUUID();
    this.#entry = entry;
    this.#restore(entry);
    useQuoteDrafts().restore(this.quoteKey, content?.quotes ?? []);
    this.persist();
  }
  clear() {
    this.pendingSend = undefined;
    this.pendingForm = "";
    const target = this.#entry.draft?.target;

    if (!target) return;
    this.files.clear();
    this.text = "";
    this.mentions = [];
    this.choices = { provider: 0, providerProfileId: "" };
    useQuoteDrafts().clear(this.quoteKey);
    this.local.remove(target);
    this.#entry = clone(
      ui.LocalComposerDraftSchema,
      this.local.make(target, this.#entry.draft?.deviceId ?? "", this.#entry.draft?.deviceName ?? ""),
    );
    this.#published = "";
    this.publishedAtMs = 0n;
  }
}
