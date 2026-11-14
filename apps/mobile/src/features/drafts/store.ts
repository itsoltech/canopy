import { create, fromBinary, toBinary, toJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import {
  ComposerLocalStore,
  composerTargetKey,
  hasComposerContent,
  mergeComposerContent,
  sameComposerInput,
} from "@canopy/domain/composer-drafts";
import { Code, ConnectError, type Client } from "@connectrpc/connect";
import * as Crypto from "expo-crypto";
import type { DraftFile } from "../attachments/useAttachmentDraft";
import type { MessageValue } from "../composer/message-value";
import type { ComposerChoices } from "../composer/draft-snapshot";
import { recoverDraft } from "./recovery";

export { MobileDrafts } from "./manager";

export class MobileComposerState {
  value: { current: MessageValue };
  files: { current: DraftFile[] };
  choices: Pick<ui.ComposerDraftContent, "model" | "effort" | "permissionMode" | "provider" | "providerProfileId">;
  #entry: ui.LocalComposerDraft;
  #listeners = new Set<() => void>();
  version = 0;
  pendingSend: ui.SendMessageRequest | undefined;
  pendingCreate: ui.CreateThreadRequest | undefined;
  preparing = false;
  reconciling = false;
  deliveryChecked = false;
  moved = "";
  flush: (() => void) | undefined;
  pendingAbort: (() => void) | undefined;
  #saving: Promise<ui.ComposerDraft> | undefined;
  #published = "";
  #mutation = Crypto.randomUUID();
  constructor(
    entry: ui.LocalComposerDraft,
    readonly local: ComposerLocalStore,
  ) {
    this.#entry = entry;
    this.#mutation = entry.mutationId || Crypto.randomUUID();
    this.#published = entry.publishedContent;
    this.pendingSend = entry.pendingSend.length
      ? fromBinary(ui.SendMessageRequestSchema, entry.pendingSend)
      : undefined;
    this.pendingCreate = entry.pendingCreate.length
      ? fromBinary(ui.CreateThreadRequestSchema, entry.pendingCreate)
      : undefined;
    this.value = {
      current: {
        text: entry.draft?.content?.text ?? "",
        mentions: entry.draft?.content?.mentions ?? [],
        quotes: entry.draft?.content?.quotes ?? [],
      },
    };
    this.files = {
      current: entry.files.map((f) => ({
        key: f.key,
        name: f.name,
        size: Number(f.size),
        kind: f.kind === "image" || f.kind === "video" ? f.kind : "file",
        attachment: f.attachment,
        contextScope: f.contextScope || undefined,
        error: f.attachment ? undefined : "Upload interrupted. Remove this file and add it again.",
      })),
    };
    const content = entry.draft?.content;
    this.choices = {
      model: content?.model,
      effort: content?.effort,
      permissionMode: content?.permissionMode,
      provider: content?.provider ?? 0,
      providerProfileId: content?.providerProfileId ?? "",
    };
  }
  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  };
  snapshot = () => this.version;
  dismissMove() {
    if (!this.moved) return;
    this.moved = "";
    this.version++;

    for (const listener of this.#listeners) listener();
  }
  reconcile(api: Client<typeof ui.GatewayService>) {
    return recoverDraft(this, api);
  }
  get requestId() {
    return this.#entry.draft?.content?.clientRequestId ?? "";
  }
  get revision() {
    return this.#entry.draft?.revision ?? 0n;
  }
  get targetKey() {
    return this.#entry.draft?.target ? composerTargetKey(this.#entry.draft.target) : undefined;
  }
  get id() {
    return this.#entry.draft?.id ?? "";
  }
  get publishedAtMs() {
    return this.#entry.draft?.updatedAtMs ?? 0n;
  }
  fork() {
    const draft = this.#entry.draft;

    if (!draft) return;
    draft.id = Crypto.randomUUID();
    draft.revision = 0n;
    draft.updatedAtMs = 0n;
    draft.takenByDeviceId = "";
    draft.takenByDeviceName = "";

    if (draft.content) draft.content.clientRequestId = Crypto.randomUUID();
    this.#published = "";
    this.#mutation = Crypto.randomUUID();
    this.persist();
  }
  get locked() {
    return this.preparing || Boolean(this.pendingSend || this.pendingCreate);
  }
  acceptMove(move: ui.ComposerDraftMove) {
    if (move.id !== this.id || this.revision > move.sourceRevision || this.locked) return;

    const unchanged =
      this.revision === move.sourceRevision &&
      !this.files.current.some((f) => !f.attachment) &&
      this.#published === toJsonString(ui.ComposerDraftContentSchema, this.content(true));

    if (unchanged) this.clear();
    else this.fork();
    this.moved = unchanged
      ? `Draft taken over on ${move.deviceName}`
      : `Draft taken over on ${move.deviceName}. Your edits are kept here.`;
    this.persist();
  }
  /** A restored local message gets a new send identity, preserving gateway CAS state. */
  renewMessage(choices?: ComposerChoices) {
    if (this.locked) throw new Error("Retry the pending message before restoring a draft.");

    if (choices) this.choices = { ...choices };

    if (this.#entry.draft?.content) this.#entry.draft.content.clientRequestId = Crypto.randomUUID();
    this.#mutation = Crypto.randomUUID();
  }
  content(wire = false) {
    const files = new Map(this.files.current.flatMap((f) => (f.attachment ? [[f.key, f.attachment] as const] : [])));

    return create(ui.ComposerDraftContentSchema, {
      ...this.choices,
      text: this.value.current.text,
      mentions: this.value.current.mentions.map((m) =>
        wire && files.has(m.name) ? { ...m, name: files.get(m.name)?.id ?? m.name } : m,
      ),
      quotes: [...(this.value.current.quotes ?? [])],
      attachments: [...files.values()],
      clientRequestId: this.requestId,
    });
  }
  persist = () => {
    if (!this.#entry.draft) return;
    const previous = this.#entry;
    this.#entry = create(ui.LocalComposerDraftSchema, {
      mutationId: this.#mutation,
      publishedContent: this.#published,
      pendingSend: this.pendingSend ? toBinary(ui.SendMessageRequestSchema, this.pendingSend) : new Uint8Array(),
      pendingCreate: this.pendingCreate ? toBinary(ui.CreateThreadRequestSchema, this.pendingCreate) : new Uint8Array(),
      draft: { ...this.#entry.draft, content: this.content() },
      files: this.files.current.map((f) => ({
        key: f.key,
        name: f.name,
        size: BigInt(f.size),
        kind: f.kind,
        attachment: f.attachment,
        contextScope: f.contextScope ?? "",
      })),
    });
    this.local.put(this.#entry);

    if (this.moved && !sameComposerInput(previous, this.#entry)) this.moved = "";
    this.version++;

    for (const listener of this.#listeners) listener();
  };
  setChoices(patch: Partial<typeof this.choices>) {
    if (this.locked) return;
    this.choices = { ...this.choices, ...patch };
    this.persist();
  }
  async publish(api: Client<typeof ui.GatewayService>): Promise<ui.ComposerDraft> {
    if (this.pendingSend || this.pendingCreate)
      throw new Error("Retry the pending message before handing off this draft.");

    if (this.local.closed) throw new Error("Pairing changed");

    if (this.#saving) {
      await this.#saving;

      return this.publish(api);
    }

    this.persist();
    const current = this.#entry.draft;

    if (!current) throw new Error("Draft unavailable");

    if (this.files.current.some((f) => !f.attachment))
      throw new Error("Wait for uploads, or remove the files that could not be attached.");
    const draft = create(ui.ComposerDraftSchema, { ...current, content: this.content(true) });

    if (!hasComposerContent(draft.content)) {
      if (draft.revision) {
        try {
          await api.deleteComposerDraft({ id: draft.id, expectedRevision: draft.revision, deviceId: draft.deviceId });
        } catch (cause) {
          if (![Code.NotFound, Code.FailedPrecondition].includes(ConnectError.from(cause).code)) throw cause;
        }

        this.clear();
      }

      return draft;
    }

    const serialized = toJsonString(
      ui.ComposerDraftContentSchema,
      draft.content ?? create(ui.ComposerDraftContentSchema),
    );

    if (this.#published === serialized && current.revision) return draft;
    await this.local.checkpoint();
    this.#saving = api.saveComposerDraft({ draft, expectedRevision: current.revision, mutationId: this.#mutation });
    let saved: ui.ComposerDraft;

    try {
      saved = await this.#saving;

      if (this.id !== draft.id) return saved;
      this.#entry = create(ui.LocalComposerDraftSchema, {
        ...this.#entry,
        draft: { ...saved, content: this.content() },
      });
      this.#published = toJsonString(
        ui.ComposerDraftContentSchema,
        saved.content ?? create(ui.ComposerDraftContentSchema),
      );
      this.#mutation = Crypto.randomUUID();
      this.persist();
    } catch (cause) {
      if (this.id !== draft.id || this.locked) return draft;

      if (![Code.NotFound, Code.FailedPrecondition].includes(ConnectError.from(cause).code)) throw cause;
      const page = await api.listComposerDrafts({ deviceId: draft.deviceId, sourceDraftIds: [draft.id] });
      const move = page.moves.find((row) => row.id === draft.id);

      if (move) {
        this.acceptMove(move);

        return draft;
      }

      this.fork();
      this.#saving = undefined;

      return this.publish(api);
    } finally {
      this.#saving = undefined;
    }

    return saved;
  }
  async publishForSend() {
    this.persist();

    return this.#entry.draft;
  }
  async take(api: Client<typeof ui.GatewayService>, incoming: ui.ComposerDraft, replace = false) {
    if (this.locked || this.files.current.some((f) => !f.attachment))
      throw new Error("Retry the pending message or wait for uploads, then retry.");
    const device = this.#entry.draft;

    if (!device || this.local.closed) throw new Error("Draft unavailable");
    this.preparing = true;
    this.persist();

    try {
      const claimed = await api.continueComposerDraft({
        id: incoming.id,
        expectedRevision: incoming.revision,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        mutationId: Crypto.randomUUID(),
      });

      this.preparing = false;
      this.apply(claimed, replace);
      this.preparing = true;
      await this.local.checkpoint();
      await this.publish(api);
    } finally {
      this.preparing = false;
      this.persist();
    }
  }
  apply(incoming: ui.ComposerDraft, replace = false) {
    if (this.locked) throw new Error("Retry the pending message before continuing a draft.");

    if (incoming.id === this.id && incoming.revision <= this.revision) return;

    if (this.files.current.some((f) => !f.attachment))
      throw new Error("Wait for uploads, or remove the files that could not be attached.");
    this.moved = "";

    const content =
      !replace && hasComposerContent(this.content()) && incoming.content
        ? mergeComposerContent(this.content(true), incoming.content)
        : incoming.content;

    this.#entry = create(ui.LocalComposerDraftSchema, {
      draft: { ...incoming, content, deviceId: incoming.takenByDeviceId, deviceName: incoming.takenByDeviceName },
    });
    this.value.current = {
      text: content?.text ?? "",
      mentions: content?.mentions ?? [],
      quotes: content?.quotes ?? [],
    };
    this.files.current = (content?.attachments ?? []).map((a) => ({
      key: a.id,
      name: a.name,
      size: Number(a.sizeBytes),
      kind: a.kind === "image" || a.kind === "video" ? a.kind : "file",
      attachment: a,
    }));
    this.choices = {
      model: content?.model,
      effort: content?.effort,
      permissionMode: content?.permissionMode,
      provider: content?.provider ?? 0,
      providerProfileId: content?.providerProfileId ?? "",
    };
    this.#published = "";
    this.#mutation = Crypto.randomUUID();
    this.persist();
  }
  clear() {
    this.moved = "";
    this.pendingSend = undefined;
    this.pendingCreate = undefined;
    const previous = this.#entry.draft;

    if (!previous?.target) return;
    this.value.current = { text: "", mentions: [], quotes: [] };
    this.files.current = [];
    this.choices = { provider: 0, providerProfileId: "" };
    this.local.remove(previous.target);
    this.#entry = this.local.make(previous.target, previous.deviceId, previous.deviceName);
    this.#published = "";
    this.version++;

    for (const listener of this.#listeners) listener();
  }
  async beginSend(request: ui.SendMessageRequest) {
    this.moved = "";
    this.deliveryChecked = false;
    this.pendingSend = request;
    this.persist();
    await this.local.checkpoint();
  }
  async beginCreate(request: ui.CreateThreadRequest) {
    this.moved = "";
    this.deliveryChecked = false;
    this.pendingCreate = request;
    this.persist();
    await this.local.checkpoint();
  }
  cancelSend(fork = false, api?: Client<typeof ui.GatewayService>) {
    if (fork) this.pendingAbort?.();
    const draft = this.#entry.draft;

    if (fork && (this.pendingSend || this.pendingCreate) && draft)
      void api
        ?.deleteComposerDraft({ id: draft.id, expectedRevision: draft.revision, deviceId: draft.deviceId })
        .catch(() => {});
    this.pendingSend = undefined;
    this.pendingCreate = undefined;

    if (fork) this.fork();
    this.persist();
  }
}
