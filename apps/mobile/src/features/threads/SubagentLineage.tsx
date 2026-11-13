import { useState } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";
import type { ui } from "@canopy/contracts";
import { subagentLineage, subagentState } from "@canopy/domain/subagents";
import { formatCount } from "@canopy/domain/format";
import { useDevicePreferences } from "../settings/device-preferences";
import { SubagentLineageRow } from "./SubagentLineageRow";
import { SubagentGroup } from "./SubagentGroup";
import { useForegroundInterval } from "../../ui/interval";

/** Shared by thread details and the composer's bounded overlay. */
export function SubagentLineage({
  threads,
  onOpen,
  style,
}: {
  threads: readonly ui.Thread[];
  onOpen: (id: string) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const device = useDevicePreferences();
  const [now, setNow] = useState(Date.now);
  const [previousOpen, setPreviousOpen] = useState(false);
  const lineage = subagentLineage(threads, now, device.values.showFinishedSubagents === "on");
  const open = device.values.finishedSubagentsExpanded === "on";
  const failures = lineage.previous.filter((t) => subagentState(t) === "failed").length;

  useForegroundInterval(() => setNow(Date.now()), 60_000, threads.length > 0);

  return (
    <View style={style}>
      {lineage.current.map((thread) => (
        <SubagentLineageRow key={thread.id} thread={thread} now={now} onOpen={onOpen} />
      ))}
      {lineage.previous.length > 0 && (
        <SubagentGroup
          label={`Previous subagents · ${formatCount(lineage.previous.length)}${failures ? ` · ${formatCount(failures)} failed` : ""}`}
          open={previousOpen}
          onToggle={() => setPreviousOpen(!previousOpen)}
        >
          {lineage.previous.map((thread) => (
            <SubagentLineageRow key={thread.id} thread={thread} now={now} onOpen={onOpen} />
          ))}
        </SubagentGroup>
      )}
      {lineage.collapsed.length > 0 && (
        <SubagentGroup
          label={`${formatCount(lineage.finished)} finished`}
          open={open}
          onToggle={() => device.set("finishedSubagentsExpanded", open ? "off" : "on")}
        >
          {lineage.collapsed.map((thread) => (
            <SubagentLineageRow key={thread.id} thread={thread} now={now} onOpen={onOpen} />
          ))}
        </SubagentGroup>
      )}
    </View>
  );
}
