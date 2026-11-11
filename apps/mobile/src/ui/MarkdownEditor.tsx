import { useState } from "react";
import { View } from "react-native";
import { Button } from "./Button";
import { AutoGrowingField } from "./AutoGrowingField";
import { Markdown } from "./markdown/Markdown";

export function MarkdownEditor({
  value,
  onChange,
  label,
  placeholder = "Write in Markdown…",
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [preview, setPreview] = useState(false);

  return (
    <View style={{ gap: 8 }}>
      <View style={{ alignItems: "flex-end" }}>
        <Button title={preview ? "Write" : "Preview"} size="sm" variant="ghost" onPress={() => setPreview(!preview)} />
      </View>
      {preview ? (
        <View style={{ minHeight: 112 }}>
          <Markdown text={value || "Nothing to preview"} />
        </View>
      ) : (
        <AutoGrowingField
          label={label}
          value={value}
          placeholder={placeholder}
          onChangeText={onChange}
          editable={!disabled}
        />
      )}
    </View>
  );
}
