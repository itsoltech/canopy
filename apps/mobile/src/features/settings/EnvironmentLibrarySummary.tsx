import { useState } from "react";
import { View } from "react-native";
import type { ui } from "@canopy/contracts";
import { librarySummary } from "@canopy/domain/environment-library";
import { Button, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { EnvironmentSkillInstall } from "./EnvironmentSkillInstall";

export function EnvironmentLibrarySummary({
  snapshot,
  workers,
  onChanged,
}: {
  snapshot: ui.AgentEnvironmentSnapshot;
  workers: ui.EnvironmentWorker[];
  onChanged: () => void;
}) {
  const summary = librarySummary(snapshot, workers);
  const [ids, setIds] = useState<string[]>([]);

  return (
    <>
      <SettingsGroup
        title="Your library"
        description="Your library is shared with your linked computers. Items are installed only on the computers you assign them to."
      >
        <SettingsRow title={summary.skills} />
        <SettingsRow title={summary.plugins} />
        <SettingsRow title={summary.instructions} />
        <View
          style={{ opacity: summary.notInstalled.length ? 1 : 0 }}
          accessibilityElementsHidden={!summary.notInstalled.length}
          importantForAccessibility={summary.notInstalled.length ? "auto" : "no-hide-descendants"}
        >
          <Button
            title="Install all not-installed skills on…"
            disabled={!summary.notInstalled.length}
            onPress={() => setIds(summary.notInstalled.map((s) => s.id))}
          />
        </View>
      </SettingsGroup>
      <Sheet
        visible={!!ids.length}
        title="Install skills"
        onClose={() => {
          setIds([]);
          onChanged();
        }}
      >
        {!!ids.length && (
          <EnvironmentSkillInstall
            ids={ids}
            snapshot={snapshot}
            onSaved={() => {
              setIds([]);
              onChanged();
            }}
          />
        )}
      </Sheet>
    </>
  );
}
