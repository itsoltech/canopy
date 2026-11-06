import { useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { Button } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";

export function EnvironmentWizard({
  steps,
  children,
  onSave,
  busy,
  disabled,
  title = "Save and sync",
}: {
  steps: string[];
  children: (step: number) => ReactNode;
  onSave: () => void;
  busy?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const [step, setStep] = useState(0);
  const c = useColors();

  return (
    <View style={{ gap: 16 }}>
      <Text accessibilityRole="header" style={[styles.chrome, { color: c.text }]}>
        {step + 1} / {steps.length} · {steps[step]}
      </Text>
      {children(step)}
      <View style={{ gap: 8 }}>
        {step > 0 && <Button secondary title="Back" disabled={busy} onPress={() => setStep(step - 1)} />}
        {step < steps.length - 1 ? (
          <Button title="Next" disabled={busy} onPress={() => setStep(step + 1)} />
        ) : (
          <Button title={title} disabled={disabled} busy={busy} onPress={onSave} />
        )}
      </View>
    </View>
  );
}
