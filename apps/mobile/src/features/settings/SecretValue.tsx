import { View } from "react-native";
import { Badge } from "../../ui/Badge";
import { Button, Field } from "../../ui/components";
import { styles } from "../../ui/theme";

export type KeyAction = "keep" | "replace" | "clear";

/**
 * A secret the gateway stores and never sends back (web: SecretValue): while one is set it reads "Set" with Replace
 * (and Clear when allowed); replacing shows a password field and a way back to the stored value. Without a stored
 * value it is a plain password field.
 */
export function SecretValue({
  label,
  set,
  action,
  onAction,
  value,
  onChange,
  allowClear = false,
}: {
  label: string;
  set: boolean;
  action: KeyAction;
  onAction: (action: KeyAction) => void;
  value: string;
  onChange: (value: string) => void;
  allowClear?: boolean;
}) {
  if (set && action !== "replace")
    return (
      <View style={[styles.row, { flexWrap: "wrap", minHeight: 40 }]}>
        {action === "clear" ? (
          <>
            <Badge tone="amber">Will be removed</Badge>
            <Button size="sm" variant="ghost" title="Undo" onPress={() => onAction("keep")} />
          </>
        ) : (
          <>
            <Badge tone="emerald" icon="lock-closed">
              Set
            </Badge>
            <Button
              size="sm"
              title="Replace"
              label={`Replace ${label}`}
              onPress={() => {
                onChange("");
                onAction("replace");
              }}
            />
            {allowClear ? (
              <Button
                size="sm"
                variant="ghost"
                title="Clear"
                label={`Clear ${label}`}
                onPress={() => onAction("clear")}
              />
            ) : null}
          </>
        )}
      </View>
    );

  return (
    <View style={{ gap: 8 }}>
      <Field
        label={label}
        value={value}
        onChangeText={onChange}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
      />
      {set ? (
        <View style={styles.row}>
          <Button
            size="sm"
            variant="ghost"
            title="Keep current"
            onPress={() => {
              onChange("");
              onAction("keep");
            }}
          />
        </View>
      ) : null}
    </View>
  );
}
