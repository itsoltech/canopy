import { useState } from "react";
import { Text, View } from "react-native";
import { isString, listOf, objectOf, parseObject, str, type JsonValue } from "@canopy/domain/json";
import { Button, Field, Notice } from "../../ui/components";
import { Checkbox } from "../../ui/Checkbox";
import { styles, useColors } from "../../ui/theme";
import type { useInteractionAnswer } from "./useInteractionAnswer";

/** MCP's flat schema: text, numeric and boolean fields, with explicit decline. */
export function ElicitationForm({
  requestJson,
  answer,
}: {
  requestJson: string;
  answer: ReturnType<typeof useInteractionAnswer>;
}) {
  const c = useColors();
  const request = parseObject(requestJson);
  const schema = objectOf(request["requestedSchema"] ?? request["schema"]);
  const required = new Set(listOf(schema["required"]).filter(isString));

  const fields = Object.entries(objectOf(schema["properties"])).map(([name, spec]) => {
    const field = objectOf(spec);

    return {
      name,
      title: str(field["title"]) || name,
      description: str(field["description"]),
      type: str(field["type"]) || "string",
    };
  });

  const [values, setValues] = useState<Record<string, string>>({});
  const [flags, setFlags] = useState<Record<string, boolean>>({});

  const invalid = fields.some((field) => {
    const value = values[field.name]?.trim() ?? "";

    if (field.type === "boolean") return false;

    if (!value) return required.has(field.name);

    return (
      (field.type === "number" || field.type === "integer") &&
      (!Number.isFinite(Number(value)) || (field.type === "integer" && !Number.isInteger(Number(value))))
    );
  });

  function submit() {
    if (invalid) return;
    const out: Record<string, JsonValue> = {};

    for (const field of fields) {
      if (field.type === "boolean") out[field.name] = flags[field.name] ?? false;
      else if (values[field.name]?.trim())
        out[field.name] =
          field.type === "number" || field.type === "integer" ? Number(values[field.name]) : values[field.name]!;
    }

    void answer.respond({ answerJson: JSON.stringify(out) });
  }

  return (
    <View style={{ gap: 12 }}>
      {str(request["message"]) ? (
        <Text selectable style={[styles.body, { color: c.text }]}>
          {str(request["message"])}
        </Text>
      ) : null}
      {fields.map((field) =>
        field.type === "boolean" ? (
          <Checkbox
            key={field.name}
            label={field.title}
            description={field.description}
            checked={flags[field.name] ?? false}
            disabled={answer.disabled}
            onChange={(value) => setFlags({ ...flags, [field.name]: value })}
          />
        ) : (
          <View key={field.name} style={{ gap: 4 }}>
            <Field
              label={`${field.title}${required.has(field.name) ? "" : " (optional)"}`}
              value={values[field.name] ?? ""}
              editable={!answer.disabled}
              onChangeText={(value) => setValues({ ...values, [field.name]: value })}
              inputMode={field.type === "number" || field.type === "integer" ? "decimal" : "text"}
            />
            {field.description ? <Notice>{field.description}</Notice> : null}
          </View>
        ),
      )}
      <Button
        title="Submit"
        variant="primary"
        busy={answer.busy}
        disabled={answer.disabled || invalid}
        onPress={submit}
      />
      <Button title="Decline" disabled={answer.disabled} onPress={() => void answer.respond({ cancelled: true })} />
    </View>
  );
}
