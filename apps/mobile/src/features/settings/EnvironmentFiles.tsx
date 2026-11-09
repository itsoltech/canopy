import { useState } from "react";
import type { SkillArtifact } from "@canopy/contracts";
import { Button, Sheet } from "../../ui/components";
import { SettingsValue } from "./SettingsValue";
import { SettingsRow } from "./SettingsGroup";
import { skillChanges, skillScript } from "@canopy/domain/skill-source";
import { environmentFileText } from "@canopy/domain/environment-review";
import { VersionComparison } from "./VersionComparison";

export function EnvironmentFiles({ artifact, before }: { artifact?: SkillArtifact; before?: SkillArtifact }) {
  const [path, setPath] = useState("");
  const file = artifact?.files.find((f) => f.path === path);
  const previous = before?.files.find((f) => f.path === path);
  const changes = artifact && before ? skillChanges(before, artifact) : [];
  const paths = [...new Set([...(artifact?.files ?? []), ...(before?.files ?? [])].map((f) => f.path))].sort();

  return (
    <>
      {paths.map((name) => (
        <SettingsRow
          key={name}
          title={name}
          description={[
            before ? changes.find((change) => change.path === name)?.kind || "Unchanged" : "Added",
            [...(artifact?.files ?? []), ...(before?.files ?? [])].some((f) => f.path === name && skillScript(f))
              ? "Script / executable"
              : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          control={<Button title="Review file" onPress={() => setPath(name)} />}
        />
      ))}
      <Sheet title={path || "File"} visible={!!path} onClose={() => setPath("")}>
        {before ? (
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
