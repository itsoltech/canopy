import { Text, View } from "react-native";
import { InteractionKind, ui } from "@canopy/contracts";
import { Icon } from "../../ui/Icon";
import { styles, useColors } from "../../ui/theme";

export function InteractionCard({ interaction }: { interaction: ui.Interaction }) {
  const c = useColors();
  let request: Record<string, unknown> = {};

  try {
    const value: unknown = JSON.parse(interaction.requestJson);

    if (value && typeof value === "object" && !Array.isArray(value)) request = value as Record<string, unknown>;
  } catch {
    /* Non-JSON provider prompts remain readable. */
  }

  const questions = Array.isArray(request.questions)
    ? (request.questions as {
        header?: string;
        question?: string;
        options?: { label?: string; description?: string }[];
      }[])
    : [];

  const permission = interaction.kind === InteractionKind.PERMISSION;

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: c.line,
        borderRadius: 16,
        backgroundColor: c.surface,
        overflow: "hidden",
      }}
    >
      <View
        style={[
          styles.row,
          {
            paddingHorizontal: 16,
            paddingVertical: 10,
            borderBottomWidth: 1,
            borderBottomColor: c.line,
          },
        ]}
      >
        <Icon name={permission ? "shield-exclamation" : "hand-raised"} color={c.warning} />
        <Text style={[styles.meta, { color: c.text }]}>
          {permission ? "Approval required" : questions[0]?.header || "Question"}
        </Text>
      </View>
      <View style={{ padding: 16, gap: 8 }}>
        <Text style={[styles.caption, { color: c.muted }]}>
          {permission
            ? "The agent is waiting for your approval."
            : interaction.asynchronous
              ? "The agent keeps working — answer any time."
              : "The agent is waiting for your answers."}
        </Text>
        {questions.length ? (
          questions.map((q, i) => (
            <View key={i} style={{ gap: 8 }}>
              <Text style={[styles.meta, { color: c.text }]}>{q.question}</Text>
              {q.options?.map((o, n) => (
                <View key={n} style={[styles.row, { padding: 10, backgroundColor: c.inset, borderRadius: 8 }]}>
                  <Text style={[styles.meta, { color: c.muted }]}>{n + 1}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.meta, { color: c.text }]}>{o.label}</Text>
                    {o.description ? <Text style={[styles.caption, { color: c.muted }]}>{o.description}</Text> : null}
                  </View>
                </View>
              ))}
            </View>
          ))
        ) : (
          <Text selectable style={[styles.meta, { color: c.body }]}>
            {String(
              request.reason ||
                request.command ||
                request.prompt ||
                request.question ||
                interaction.toolName ||
                interaction.requestJson,
            )}
          </Text>
        )}
        <Text style={[styles.caption, { color: c.muted }]}>Open this thread in Canopy on the web to respond.</Text>
      </View>
    </View>
  );
}
