import { useState } from "react";
import type { SkillArtifact } from "@canopy/contracts";
import { Button, Sheet } from "../../ui/components";
import { SettingsValue } from "./SettingsValue";
import { SettingsRow } from "./SettingsGroup";

export function EnvironmentFiles({ artifact, before }: { artifact?: SkillArtifact; before?: SkillArtifact }) {
  const [path, setPath] = useState("");
  const file = artifact?.files.find((f) => f.path === path);
  const previous = before?.files.find((f) => f.path === path);

  return (
    <>
      {artifact?.files.map((f) => (
        <SettingsRow
          key={f.path}
          title={f.path}
          description={`${f.content.length} bytes${f.executable ? " · Executable" : ""}`}
          control={<Button secondary title="Review file" onPress={() => setPath(f.path)} />}
        />
      ))}
      {before?.files
        .filter((f) => !artifact?.files.some((a) => a.path === f.path))
        .map((f) => (
          <SettingsValue key={f.path} title={`Removed: ${f.path}`} value={new TextDecoder().decode(f.content)} />
        ))}
      <Sheet title={path || "File"} visible={!!file} onClose={() => setPath("")}>
        {previous && <SettingsValue title="Previously approved" value={new TextDecoder().decode(previous.content)} />}
        {file && <SettingsValue title="Selected version" value={new TextDecoder().decode(file.content)} />}
      </Sheet>
    </>
  );
}
