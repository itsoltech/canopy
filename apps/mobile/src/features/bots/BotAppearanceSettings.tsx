import { useState } from "react";
import type { bots } from "@canopy/contracts";
import { mascotShapes, mascotColors } from "@canopy/ui/mascot";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { View } from "react-native";
import { MascotAvatar } from "./BotAvatar";
import { Field } from "../../ui/components";

export function BotAppearanceSettings({
  config,
  onChange,
  disabled,
}: {
  config: bots.BotConfiguration;
  onChange: (c: bots.BotConfiguration) => void;
  disabled: boolean;
}) {
  const [picker, setPicker] = useState("");

  return (
    <View style={{ gap: 12 }}>
      <MascotAvatar id="preview" shape={config.shape} color={config.color} name={config.name} size={64} />
      <SelectField
        label="Shape"
        value={mascotShapes.find((s) => s.id === config.shape)?.label || "Round"}
        disabled={disabled}
        onPress={() => setPicker("shape")}
      />
      <SelectField label="Color" value={config.color} disabled={disabled} onPress={() => setPicker("color")} />
      <Field
        label="Custom color"
        value={config.color}
        editable={!disabled}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={7}
        onChangeText={(color) => onChange({ ...config, color })}
        placeholder="#8b5cf6"
      />
      <PickerSheet
        title={picker === "shape" ? "Shape" : "Color"}
        visible={!!picker}
        onClose={() => setPicker("")}
        value={picker === "shape" ? config.shape : config.color}
        sections={[
          {
            options:
              picker === "shape"
                ? mascotShapes.map((s) => ({ value: s.id, label: s.label }))
                : mascotColors.map((color) => ({ value: color.value, label: color.label })),
          },
        ]}
        onSelect={(value) => onChange({ ...config, [picker === "shape" ? "shape" : "color"]: value })}
      />
    </View>
  );
}
