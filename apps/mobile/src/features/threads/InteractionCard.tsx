import { Text, View } from "react-native";
import { InteractionKind, ui } from "@canopy/contracts";
import { Icon } from "../../ui/Icon";
import { RequestCountdown } from "../../ui/RequestCountdown";
import { styles, useColors } from "../../ui/theme";

interface InteractionRequest {
  questions?: unknown;
  reason?: unknown;
  command?: unknown;
  prompt?: unknown;
  question?: unknown;
}

interface QuestionOption {
  label?: string;
  description?: string;
}

interface Question {
  header?: string;
  question?: string;
  options?: QuestionOption[];
}

function isInteractionRequest(value: unknown): value is InteractionRequest {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isQuestionOption(value: unknown): value is QuestionOption {
  return (
    !!value &&
    typeof value === "object" &&
    (!("label" in value) || value.label === undefined || typeof value.label === "string") &&
    (!("description" in value) || value.description === undefined || typeof value.description === "string")
  );
}

function isQuestion(value: unknown): value is Question {
  return (
    !!value &&
    typeof value === "object" &&
    (!("header" in value) || value.header === undefined || typeof value.header === "string") &&
    (!("question" in value) || value.question === undefined || typeof value.question === "string") &&
    (!("options" in value) ||
      value.options === undefined ||
      (Array.isArray(value.options) && value.options.every(isQuestionOption)))
  );
}

function isQuestions(value: unknown): value is Question[] {
  return Array.isArray(value) && value.every(isQuestion);
}

export function InteractionCard({ interaction }: { interaction: ui.Interaction }) {
  const c = useColors();
  let request: InteractionRequest = {};

  try {
    const value: unknown = JSON.parse(interaction.requestJson);

    if (isInteractionRequest(value)) request = value;
  } catch {
    /* Non-JSON provider prompts remain readable. */
  }

  const questions = isQuestions(request.questions) ? request.questions : [];

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
        <Text numberOfLines={1} style={[styles.meta, { flex: 1, color: c.text }]}>
          {permission ? "Approval required" : questions[0]?.header || "Question"}
        </Text>
        <RequestCountdown
          expiresAt={interaction.expiresAt}
          pending={interaction.status === "pending"}
          style={{ textAlign: "right" }}
        />
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
        <Text style={[styles.caption, { color: c.muted }]}>
          {permission
            ? "Approvals need Canopy on the web. Open this thread there to respond."
            : "This form needs Canopy on the web. Open this thread there to respond."}
        </Text>
      </View>
    </View>
  );
}
