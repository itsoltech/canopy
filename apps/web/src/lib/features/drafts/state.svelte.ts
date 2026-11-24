import { create, clone, fromBinary, toBinary } from "@bufbuild/protobuf";
import { PermissionMode, SandboxProfileSchema, ui, type Mention, type SandboxProfile } from "@canopy/contracts";
import type { AttachmentLimits } from "@canopy/domain";
import {
  ComposerLocalStore,
  composerTargetKey,
  hasComposerContent,
  isUnplacedComposerTarget,
  sameComposerInput,
} from "@canopy/domain/composer-drafts";
import { AttachmentDraft } from "#lib/features/attachments/draft.svelte.ts";
import { useQuoteDrafts } from "#lib/features/quotes/quote-drafts.svelte.ts";
import { saveDraft, deleteDraft, continueDraft, listDrafts } from "./api.ts";
import { trimValue } from "#lib/features/mentions/editor.ts";
import { toWire } from "#lib/features/quotes/quote.ts";
import { HttpError } from "#lib/shared/http.ts";
import { recoverDraft } from "./recovery.ts";
import { restoreLocalFiles } from "./local-files.ts";
import {
  draftChoices,
  draftContentJson,
  matchesPublishedSandbox,
  takeDraftContent,
  type DraftChoices,
} from "./draft-content.ts";
import { restoreComposer, snapshotComposer, type ComposerSnapshot } from "./snapshot.ts";

export type { ComposerSnapshot } from "./snapshot.ts";

/** Local snapshot/restore is independent of gateway handoff (`apply`) and its revision. */
export class WebComposerDraft {
  text = $state("");
  mentions = $state<Mention[]>([]);
  choices = $state<DraftChoices>(draftChoices(undefined));
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
  #clearSandboxProfile = false;
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
    this.quoteKey = entry.draft?.target?.threadId || `composer:${entry.draft?.id ?? crypto.randomUUID()}`;
    this.files = new AttachmentDraft(limits, { onUploaded: () => this.persist() });
    this.#restore(entry);
  }
  #restore(entry: ui.LocalComposerDraft) {
    this.publishedAtMs = entry.draft?.updatedAtMs ?? 0n;
    const content = entry.draft?.content;
    this.#clearSandboxProfile = entry.clearSandboxProfile;
    this.text = content?.text ?? "";
    this.mentions = content?.mentions ?? [];
    this.choices = draftChoices(content);
    this.files.files = restoreLocalFiles(entry.files);
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
  get targetKey() {
    return this.#entry.draft?.target ? composerTargetKey(this.#entry.draft.target) : undefined;
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
  selectSandboxPermissions(permissionMode: PermissionMode, profile: SandboxProfile | undefined) {
    if (this.locked) return;

    if (profile) this.#clearSandboxProfile = false;
    else if (this.choices.sandboxProfile) this.#clearSandboxProfile = true;

    this.choices = {
      ...this.choices,
      permissionMode,
      sandboxProfile: profile && clone(SandboxProfileSchema, profile),
    };
  }
  acceptMove(move: ui.ComposerDraftMove) {
    if (move.id !== this.id || this.revision > move.sourceRevision || this.locked) return;
    this.activate();

    const unchanged =
      this.revision === move.sourceRevision &&
      !this.files.blocker &&
      this.#published === draftContentJson(this.content(true));

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
    return snapshotComposer(this);
  }
  restore(snapshot: ComposerSnapshot) {
    restoreComposer(this, snapshot);

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
    const previous = this.#entry;

    if (!draft) return;
    this.#entry = create(ui.LocalComposerDraftSchema, {
      mutationId: this.#mutation,
      publishedContent: this.#published,
      pendingSend: this.pendingSend ? toBinary(ui.SendMessageRequestSchema, this.pendingSend) : new Uint8Array(),
      pendingForm: this.pendingForm,
      clearSandboxProfile: this.#clearSandboxProfile,
      draft: { ...draft, content: this.content() },
      files: this.files.attached.map((file) => ({
        key: file.key,
        name: file.name,
        size: BigInt(file.size),
        kind: file.image ? "image" : file.video ? "video" : "file",
        attachment: file.attachment,
        contextScope: file.contextScope ?? "",
      })),
    });
    this.local.put(this.#entry);

    if (this.moved && !sameComposerInput(previous, this.#entry)) this.moved = "";
  }
  async publish(retryClear = true): Promise<ui.ComposerDraft> {
    if (this.retired) throw new Error("Draft changed in another tab");

    if (this.pendingSend || this.pendingForm)
      throw new Error("Retry the pending message before handing off this draft.");

    if (this.local.closed) throw new Error("Gateway changed");

    if (this.#saving) {
      await this.#saving;

      return this.publish(retryClear);
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

    const serialized = draftContentJson(outgoing.content);

    const clearSandboxProfile = this.#clearSandboxProfile && !outgoing.content?.sandboxProfile;

    if (this.#published === serialized && draft.revision && !clearSandboxProfile) return outgoing;
    const mutation = this.#mutation;
    const saving = this.local.checkpoint().then(() => saveDraft(outgoing, mutation, clearSandboxProfile));
    this.#saving = saving;
    let saved: ui.ComposerDraft;

    try {
      saved = await saving;

      if (this.retired || this.id !== outgoing.id) return saved;

      if (clearSandboxProfile && !saved.content?.sandboxProfile) this.#clearSandboxProfile = false;
      this.#restorePreservedSandbox(outgoing, saved);
      this.publishedAtMs = saved.updatedAtMs;
      this.#entry = create(ui.LocalComposerDraftSchema, {
        ...this.#entry,
        draft: { ...saved, content: this.content() },
      });
      this.#published = draftContentJson(saved.content);
      this.#mutation = crypto.randomUUID();
      this.error = "";
      this.persist();
    } catch (cause) {
      if (this.retired || this.id !== outgoing.id || this.locked) return outgoing;

      const status = cause instanceof HttpError ? cause.status : 0;

      if (status === 409 || (status === 404 && !isUnplacedComposerTarget(outgoing.target))) {
        const page = await listDrafts(draft.deviceId, "", "", [outgoing.id]);
        const move = page.moves.find((row) => row.id === outgoing.id);

        if (move) {
          this.acceptMove(move);

          return outgoing;
        }

        this.fork();
        this.#saving = undefined;

        return this.publish(retryClear);
      }

      if (cause instanceof HttpError && cause.status === 426) {
        this.error = cause.message;
        throw cause;
      }

      this.error = "Could not hand off this draft. Check the connection, then retry.";
      throw new Error(this.error);
    } finally {
      if (this.#saving === saving) this.#saving = undefined;
    }

    // A replay can acknowledge an earlier save with this mutation ID. Retry the outstanding clear at the new revision.
    return retryClear && clearSandboxProfile && this.#clearSandboxProfile ? this.publish(false) : saved;
  }
  #restorePreservedSandbox(outgoing: ui.ComposerDraft, saved: ui.ComposerDraft) {
    const sandboxProfile = saved.content?.sandboxProfile;

    // The gateway may preserve a profile that an older client omitted. Keep any newer local choice.
    if (
      sandboxProfile &&
      !outgoing.content?.sandboxProfile &&
      !this.choices.sandboxProfile &&
      !this.#clearSandboxProfile
    )
      this.choices = { ...this.choices, permissionMode: PermissionMode.FULL_AUTO, sandboxProfile };
  }
  async publishForSend() {
    const targetNeedsSave = () =>
      this.revision && !this.#published && isUnplacedComposerTarget(this.#entry.draft?.target);

    if (targetNeedsSave() || this.#clearSandboxProfile || this.choices.sandboxProfile) {
      await this.#saving;

      const pending = () =>
        targetNeedsSave() ||
        this.#clearSandboxProfile ||
        !matchesPublishedSandbox(this.#published, this.choices.sandboxProfile);

      if (this.revision && pending()) {
        await this.publish();

        if (targetNeedsSave()) throw new Error("Could not save this draft. Retry before sending.");

        if (pending()) throw new Error("Could not save this draft’s sandbox choice. Retry before sending.");
      }
    }

    this.persist();

    return this.#entry.draft;
  }
  async beginSend(request: ui.SendMessageRequest) {
    this.moved = "";
    this.deliveryChecked = false;
    this.pendingSend = request;
    this.persist();
    await this.local.checkpoint();
  }
  async beginForm(form: FormData) {
    this.moved = "";
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
  rejectForm(requestId: string) {
    const content = this.#entry.draft?.content;

    if (
      content?.clientRequestId !== requestId ||
      new URLSearchParams(this.pendingForm).get("clientRequestId") !== requestId
    )
      return;
    content.clientRequestId = crypto.randomUUID();
    this.#mutation = crypto.randomUUID();
    this.cancelSend();
    this.local.flush();
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
    this.moved = "";

    const content = takeDraftContent(this.content(true), incoming.content, replace);

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
    this.moved = "";
    this.pendingSend = undefined;
    this.pendingForm = "";
    const target = this.#entry.draft?.target;

    if (!target) return;
    this.files.clear();
    this.text = "";
    this.mentions = [];
    this.choices = draftChoices(undefined);
    this.#clearSandboxProfile = false;
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
