import { Text, View } from "react-native";
import { ItemStatus } from "@canopy/contracts";
import { Icon } from "../../../ui/Icon";
import { Markdown } from "../../../ui/markdown";
import { Spinner } from "../../../ui/Badge";
import { font, styles, useColors } from "../../../ui/theme";
import { useTone } from "../../../ui/tone";
import { ItemFrame } from "../ItemFrame";
import { Aside, RowTitle } from "./parts";

type Step = { readonly text: string; readonly status: string };

/** Plan steps or a todo list; the completed count stays in the folded row (web: ChecklistView). */
export function ChecklistView({
  title,
  text = "",
  steps,
  status = ItemStatus.COMPLETED,
}: {
  title: string;
  text?: string;
  steps: readonly Step[];
  status?: ItemStatus;
}) {
  const done = steps.filter((s) => s.status === "completed").length;

  return (
    <ItemFrame
      icon="queue-list"
      status={status}
      label={title}
      title={<RowTitle subject={title} />}
      aside={steps.length > 0 ? <Aside>{`${done} of ${steps.length} done`}</Aside> : undefined}
    >
      {text ? <Markdown text={text} /> : null}
      {steps.length > 0 && <ChecklistSteps steps={steps} />}
    </ItemFrame>
  );
}

/** Steps with their state: done ones struck through, the current one bold (web: ChecklistSteps). */
export function ChecklistSteps({ steps }: { steps: readonly Step[] }) {
  const c = useColors();
  const emerald = useTone("emerald").text;
  const sky = useTone("sky").text;

  return (
    <View style={{ gap: 6 }}>
      {steps.map((step, index) => (
        <View key={index} style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ height: 24, justifyContent: "center" }}>
            {step.status === "completed" ? (
              <Icon name="check-circle" color={emerald} label="Done" />
            ) : step.status === "in_progress" ? (
              <View accessibilityLabel="In progress">
                <Spinner color={sky} size={16} />
              </View>
            ) : (
              <View
                accessibilityLabel="Pending"
                style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center" }}
              >
                <View style={{ width: 12, height: 12, borderRadius: 6, borderWidth: 1, borderColor: c.faint }} />
              </View>
            )}
          </View>
          <Text
            style={[
              styles.body,
              { flex: 1 },
              step.status === "completed"
                ? { color: c.muted, textDecorationLine: "line-through" }
                : step.status === "in_progress"
                  ? { color: c.text, fontFamily: font.medium }
                  : { color: c.soft },
            ]}
          >
            {step.text}
          </Text>
        </View>
      ))}
    </View>
  );
}
