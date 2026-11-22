import { PermissionMode, type SandboxProfile, type ui } from "@canopy/contracts";
import { normalizeSandboxProfile, sandboxBinding } from "@canopy/domain/sandbox-profiles";
import { Effect } from "effect";
import { Invalid } from "../store/errors.ts";
import { SettingsStore } from "../store/settings.ts";
import { DRAFT_SANDBOX_RESELECT } from "../store/thread-sandbox.ts";

export type DraftSandboxSelection = Pick<
  ui.CreateThreadRequest,
  "permissionMode" | "sandboxProfileId" | "sandboxProfileDigest"
>;

const reselect = () => new Invalid(DRAFT_SANDBOX_RESELECT);

export function validateDraftSandbox(profile: SandboxProfile | undefined, threadId: string) {
  if (!profile) return Effect.succeed(undefined);

  if (threadId) return Effect.fail(new Invalid("Sandbox profiles can be selected only in drafts for new threads."));

  return Effect.try({ try: () => normalizeSandboxProfile(profile), catch: reselect });
}

export function draftSandboxDigest(owner: string, saved: SandboxProfile, selection: DraftSandboxSelection | undefined) {
  return Effect.gen(function* () {
    if (selection?.sandboxProfileId !== saved.id || selection.permissionMode !== PermissionMode.FULL_AUTO)
      return yield* Effect.fail(reselect());

    const settings = yield* SettingsStore.use((store) => store.user(owner));
    const profile = settings.sandboxProfiles?.profiles.find((candidate) => candidate.id === saved.id);

    if (!profile) return yield* Effect.fail(reselect());

    return yield* Effect.try({
      try: () => {
        const digest = sandboxBinding(saved).digest;

        if (
          sandboxBinding(profile).digest !== digest ||
          (selection.sandboxProfileDigest && selection.sandboxProfileDigest !== digest)
        )
          throw reselect();

        return digest;
      },
      catch: reselect,
    });
  });
}
