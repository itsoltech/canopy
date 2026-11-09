import type { SkillArtifact, SkillFile, ui } from "@canopy/contracts";
import { Notice } from "../../ui/components";
import { EnvironmentFiles } from "./EnvironmentFiles";
import { ResourceState, type useSettingsResource } from "./resource";

export function SkillFileReview({
  files,
  zip,
  draft,
  before,
  preview,
}: {
  files: SkillFile[];
  zip?: Uint8Array;
  draft: ui.LibrarySkill;
  before?: SkillArtifact;
  preview: ReturnType<typeof useSettingsResource<ui.AgentEnvironmentSnapshot>>;
}) {
  const artifact: SkillArtifact | undefined = files.length
    ? {
        $typeName: "canopy.worker.v1.SkillArtifact",
        name: draft.name,
        description: "",
        checksum: "",
        files,
      }
    : preview.data?.previewSkillArtifact;

  const message = artifact
    ? "Review the selected version before saving. Saving syncs these files to the assigned computers."
    : preview.error
      ? ""
      : preview.initialLoading
        ? "Loading selected version…"
        : draft.id
          ? "This computer cannot preview the selected version. Update Canopy on this computer, then reopen this skill."
          : "Choose a skill folder or ZIP to review its files.";

  return (
    <>
      {zip ? (
        <Notice>
          The gateway unpacks and validates this ZIP when you save. Choose a folder to review individual files before
          saving.
        </Notice>
      ) : (
        artifact && <EnvironmentFiles artifact={artifact} before={before} />
      )}
      {!files.length && !zip && (
        <ResourceState resource={preview}>{message ? <Notice>{message}</Notice> : null}</ResourceState>
      )}
    </>
  );
}
