import { useState } from "react";
import type { SkillArtifact, SkillFile } from "@canopy/contracts";
import { Button, Notice, Sheet } from "../../ui/components";
import { Diff } from "../../ui/Diff";
import { SettingsValue } from "./SettingsValue";
import { SettingsRow } from "./SettingsGroup";
import { skillChanges, skillScript } from "@canopy/domain/skill-source";
import { environmentFileDiff, environmentFileText } from "@canopy/domain/environment-review";
import { VersionComparison } from "./VersionComparison";

export function EnvironmentFiles({
  artifact,
  before,
  reviewUpdate = false,
}: {
  artifact?: SkillArtifact;
  before?: SkillArtifact;
  reviewUpdate?: boolean;
}) {
  const [path, setPath] = useState("");
  const file = artifact?.files.find((f) => f.path === path);
  const previous = before?.files.find((f) => f.path === path);
  const changes = artifact && before ? skillChanges(before, artifact) : [];
  const files = [...(artifact?.files ?? []), ...(before?.files ?? [])];

  const paths =
    reviewUpdate && before ? changes.map((change) => change.path) : [...new Set(files.map((f) => f.path))].sort();

  return (
    <>
      {reviewUpdate && before && !paths.length && <Notice>This commit has no file changes.</Notice>}
      {paths.map((name) => (
        <SettingsRow
          key={name}
          title={name}
          description={[
            before ? changes.find((change) => change.path === name)?.kind || "Unchanged" : "Added",
            files.some((f) => f.path === name && skillScript(f)) ? "Script / executable" : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          control={<Button title="Review file" onPress={() => setPath(name)} />}
        />
      ))}
      <Sheet title={path || "File"} visible={!!path} onClose={() => setPath("")}>
        {before && reviewUpdate ? (
          path && <SkillUpdateDiff path={path} before={previous} after={file} />
        ) : before ? (
          <VersionComparison
            before={environmentFileText(previous)}
            after={environmentFileText(file)}
            beforeLabel="Previously approved"
            afterLabel="Selected version"
          />
        ) : (
          <SettingsValue title="Selected version" value={environmentFileText(file)} />
        )}
      </Sheet>
    </>
  );
}

function SkillUpdateDiff({
  path,
  before,
  after,
}: {
  path: string;
  before?: SkillFile | undefined;
  after?: SkillFile | undefined;
}) {
  const review = environmentFileDiff(before, after);

  return (
    <>
      {review.mode && <Notice>{review.mode}</Notice>}
      {review.kind === "text" ? (
        review.diff ? (
          <Diff diff={review.diff} label={`Changes to ${path}`} bare toolbar={false} />
        ) : (
          !review.mode && <Notice>Empty file.</Notice>
        )
      ) : (
        <>
          <Notice>
            {review.kind === "binary"
              ? "Binary file."
              : "The diff is too large to display. Review the file versions below."}
          </Notice>
          {before && <SettingsValue title="Current version" value={environmentFileText(before) || "(Empty file)"} />}
          {after && <SettingsValue title="Upstream candidate" value={environmentFileText(after) || "(Empty file)"} />}
        </>
      )}
    </>
  );
}
