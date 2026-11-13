import { memo, useMemo, useState } from "react";
import { View } from "react-native";
import { LayoutAnimationConfig } from "react-native-reanimated";
import type { ui } from "@canopy/contracts";
import { sameItems } from "@canopy/domain/same-items";
import type { WorkGroupChoices } from "@canopy/domain/work-group-choices";
import { useColors } from "../../ui/theme";
import { WorkGroup } from "./WorkFold";
import { ActivityGroup, activityHeader, activitySurface } from "./activity-header";
import { workRows, type BodyRow, type WorkRow } from "./turn-plan";
import { BodyRowView } from "./TimelineBodyRow";
import { TimelineDisclosure } from "./TimelineDisclosure";
import { useThreadScrollTarget } from "../../ui/thread-scroll-items";

type GroupRow = Extract<WorkRow, { kind: "group" }>;

/** Each group's manual choice is local: toggling it does not rebuild the turn or its sibling groups. */
const ToolGroup = memo(function ToolGroup({
  row,
  expanded,
  steers,
  ended,
  choices,
}: {
  row: GroupRow;
  expanded: boolean;
  steers: readonly ui.Steer[];
  ended: boolean;
  choices: WorkGroupChoices;
}) {
  const c = useColors();
  const target = useThreadScrollTarget();

  const [, setOpen] = useState(() => {
    if (row.rows.some((inner) => inner.key === target)) choices.choose(row.key, true);

    return choices.open(row.key, !ended, expanded);
  });

  const open = choices.open(row.key, !ended, expanded);

  return (
    <View style={[activityHeader.shell, activitySurface(c)]}>
      <WorkGroup
        label={row.label}
        open={open}
        running={row.running}
        hint={row.hint}
        icon={row.icon}
        status={row.status}
        statusCount={row.statusCount}
        onToggle={() => {
          choices.choose(row.key, !open);
          setOpen((previous) => !previous);
        }}
      />
      <TimelineDisclosure open={open}>
        <ActivityGroup value={true}>
          <View style={{ paddingHorizontal: 8, paddingBottom: row.rows.length ? 4 : 0 }}>
            {row.rows.map((inner) => (
              <BodyRowView key={inner.key} row={inner} steers={steers} ended={ended} />
            ))}
          </View>
        </ActivityGroup>
      </TimelineDisclosure>
    </View>
  );
});

/** Stable work rows survive closing; no entrance or cell layout animation competes with the accordion. */
export const WorkRail = memo(
  function WorkRail({
    work,
    steers,
    ended,
    expanded,
    choices,
  }: {
    work: readonly BodyRow[];
    steers: readonly ui.Steer[];
    ended: boolean;
    expanded: boolean;
    choices: WorkGroupChoices;
  }) {
    const c = useColors();
    const rows = useMemo(() => workRows(work), [work]);

    return (
      <View style={{ paddingTop: 4, marginLeft: 8, paddingLeft: 16, borderLeftWidth: 1, borderColor: c.rule, gap: 4 }}>
        <LayoutAnimationConfig skipEntering>
          {rows.map((row) =>
            row.kind === "row" ? (
              <BodyRowView key={row.row.key} row={row.row} steers={steers} ended={ended} />
            ) : (
              <ToolGroup key={row.key} row={row} expanded={expanded} choices={choices} steers={steers} ended={ended} />
            ),
          )}
        </LayoutAnimationConfig>
      </View>
    );
  },
  (before, after) =>
    sameItems(before.work, after.work) &&
    before.steers === after.steers &&
    before.ended === after.ended &&
    before.expanded === after.expanded &&
    before.choices === after.choices,
);
