import { create, equals, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { PermissionMode, SandboxProfileSchema, ui, type SandboxProfile } from "@canopy/contracts";
import { hasComposerContent, mergeComposerContent } from "@canopy/domain/composer-drafts";

export type DraftChoices = Pick<
  ui.ComposerDraftContent,
  "model" | "effort" | "serviceTier" | "permissionMode" | "provider" | "providerProfileId" | "sandboxProfile"
>;

export function draftChoices(content: ui.ComposerDraftContent | undefined): DraftChoices {
  return {
    model: content?.model,
    effort: content?.effort,
    serviceTier: content?.serviceTier,
    permissionMode: content?.sandboxProfile ? PermissionMode.FULL_AUTO : content?.permissionMode,
    provider: content?.provider ?? 0,
    providerProfileId: content?.providerProfileId ?? "",
    sandboxProfile: content?.sandboxProfile,
  };
}

export function takeDraftContent(
  local: ui.ComposerDraftContent,
  incoming: ui.ComposerDraftContent | undefined,
  replace: boolean,
): ui.ComposerDraftContent | undefined {
  if (replace || !incoming || !hasComposerContent(local)) return incoming;
  const content = mergeComposerContent(local, incoming);
  const profile = local.sandboxProfile ?? incoming.sandboxProfile;

  if (profile) {
    content.sandboxProfile = profile;
    content.permissionMode = PermissionMode.FULL_AUTO;
  }

  return content;
}

export function draftContentJson(content: ui.ComposerDraftContent | undefined) {
  return toJsonString(ui.ComposerDraftContentSchema, content ?? create(ui.ComposerDraftContentSchema));
}

export function matchesPublishedSandbox(published: string, profile: SandboxProfile | undefined) {
  try {
    const stored = fromJsonString(ui.ComposerDraftContentSchema, published || "{}", {
      ignoreUnknownFields: true,
    }).sandboxProfile;

    return stored && profile ? equals(SandboxProfileSchema, stored, profile) : stored === profile;
  } catch {
    return false;
  }
}
