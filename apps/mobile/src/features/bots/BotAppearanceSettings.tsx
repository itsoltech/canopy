import { useState } from "react";
import type { bots } from "@canopy/contracts";
import { mascotShapes, mascotColors, normalizeColor } from "@canopy/ui/mascot";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { View } from "react-native";
import { MascotAvatar } from "./BotAvatar";
import { Field } from "../../ui/components";

const customOption = "custom";

export function BotAppearanceSettings({
  config,
  onChange,
  disabled,
  creating,
}: {
  config: bots.BotConfiguration;
  onChange: (c: bots.BotConfiguration) => void;
  disabled: boolean;
  creating: boolean;
}) {
  const [picker, setPicker] = useState("");
  const [editingColor, setEditingColor] = useState(false);
  const normalized = normalizeColor(config.color);
  const preset = mascotColors.find((color) => color.value === normalized);
  const custom = editingColor || !preset;
  const selectedColor = creating ? (custom ? customOption : preset.value) : config.color;

  return (
    <View style={{ gap: 12 }}>
      {!creating && (
        <MascotAvatar id="preview" shape={config.shape} color={config.color} name={config.name} size={64} />
      )}
      <SelectField
        label="Shape"
        value={mascotShapes.find((s) => s.id === config.shape)?.label || "Round"}
        disabled={disabled}
        onPress={() => setPicker("shape")}
      />
      <SelectField
        label="Color"
        value={creating ? (custom ? "Custom" : preset.label) : config.color}
        disabled={disabled}
        onPress={() => setPicker("color")}
      />
      {(!creating || custom) && (
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
      )}
      <PickerSheet
        title={picker === "shape" ? "Shape" : "Color"}
        visible={!!picker}
        onClose={() => setPicker("")}
        value={picker === "shape" ? config.shape : selectedColor}
        sections={[
          {
            options:
              picker === "shape"
                ? mascotShapes.map((s) => ({ value: s.id, label: s.label }))
                : [...mascotColors, ...(creating ? [{ value: customOption, label: "Enter a custom color" }] : [])],
          },
        ]}
        onSelect={(value) => {
          if (picker === "shape") {
            onChange({ ...config, shape: value });
          } else {
            setEditingColor(value === customOption);

            if (value !== customOption) onChange({ ...config, color: value });
          }
        }}
      />
    </View>
  );
}
