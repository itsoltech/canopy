import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { requestJson } from "#lib/shared/http.ts";
import { decode, encode } from "#lib/shared/wire.ts";

export const draftDelivery = async (request: ui.GetComposerDraftDeliveryRequest) =>
  decode(
    ui.ComposerDraftDeliverySchema,
    await requestJson("POST", "/api/drafts/delivery", encode(ui.GetComposerDraftDeliveryRequestSchema, request)),
  );

export const saveDraft = async (draft: ui.ComposerDraft, mutationId: string) =>
  decode(
    ui.ComposerDraftSchema,
    await requestJson(
      "PUT",
      "/api/drafts",
      encode(
        ui.SaveComposerDraftRequestSchema,
        create(ui.SaveComposerDraftRequestSchema, { draft, expectedRevision: draft.revision, mutationId }),
      ),
    ),
  );

export const listDrafts = async (deviceId: string, threadId = "", pageToken = "") =>
  decode(
    ui.ComposerDraftPageSchema,
    await requestJson(
      "POST",
      "/api/drafts/list",
      encode(
        ui.ListComposerDraftsRequestSchema,
        create(ui.ListComposerDraftsRequestSchema, { deviceId, threadId, pageToken, pageSize: 20 }),
      ),
    ),
  );

export const continueDraft = async (
  draft: ui.ComposerDraft,
  deviceId: string,
  deviceName: string,
  mutationId: string,
) =>
  decode(
    ui.ComposerDraftSchema,
    await requestJson(
      "POST",
      "/api/drafts/continue",
      encode(
        ui.ContinueComposerDraftRequestSchema,
        create(ui.ContinueComposerDraftRequestSchema, {
          id: draft.id,
          expectedRevision: draft.revision,
          deviceId,
          deviceName,
          mutationId,
        }),
      ),
    ),
  );

export const deleteDraft = (draft: ui.ComposerDraft, deviceId: string) =>
  requestJson(
    "DELETE",
    "/api/drafts",
    encode(
      ui.DeleteComposerDraftRequestSchema,
      create(ui.DeleteComposerDraftRequestSchema, { id: draft.id, expectedRevision: draft.revision, deviceId }),
    ),
  );
