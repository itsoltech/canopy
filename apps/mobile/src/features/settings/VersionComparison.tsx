import { textChanges } from "@canopy/domain/environment-review";
import { Notice } from "../../ui/components";
import { SettingsValue } from "./SettingsValue";

export function VersionComparison({
  before,
  after,
  beforeLabel = "On this computer",
  afterLabel = "Library version",
}: {
  before: string;
  after: string;
  beforeLabel?: string;
  afterLabel?: string;
}) {
  const changes = textChanges(before, after);

  return (
    <>
      <Notice>
        {changes.removed.length || changes.added.length
          ? `${changes.removed.length} lines replaced by ${changes.added.length} lines from line ${changes.line}.`
          : "No text changes."}
      </Notice>
      {changes.removed.length > 0 && <SettingsValue title="Removed lines" value={changes.removed.join("\n")} />}
      {changes.added.length > 0 && <SettingsValue title="Added lines" value={changes.added.join("\n")} />}
      <SettingsValue title={beforeLabel} value={before} />
      <SettingsValue title={afterLabel} value={after} />
    </>
  );
}
