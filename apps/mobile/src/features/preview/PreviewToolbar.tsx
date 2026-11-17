import { useState } from "react";
import { ScrollView } from "react-native";
import { create } from "@bufbuild/protobuf";
import { AgentPreviewInputSchema, AgentTool, type AgentPreviewTarget } from "@canopy/contracts";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { Segmented } from "../../ui/Segmented";
import { PreviewControls } from "./PreviewControls";
import type { useAgentPreview } from "./useAgentPreview";

export function PreviewToolbar({
  preview,
  tool,
  targetId,
  live,
  compact,
  visible,
  onToolChange,
  onTargetChange,
}: {
  preview: ReturnType<typeof useAgentPreview>;
  tool: AgentTool;
  targetId: string;
  live: boolean;
  compact: boolean;
  visible: boolean;
  onToolChange: (tool: AgentTool) => void;
  onTargetChange: (target: AgentPreviewTarget | undefined) => void;
}) {
  const [picker, setPicker] = useState(false);

  function chooseTarget(id: string) {
    if (tool === AgentTool.BROWSER) preview.input(create(AgentPreviewInputSchema, { kind: "tab", text: id }));
    else onTargetChange(preview.targets.find((entry) => entry.id === id));
  }

  return (
    <>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={[
          compact ? { width: "45%", flexGrow: 0 } : { maxHeight: "45%", flexGrow: 0 },
          !visible && { display: "none" },
        ]}
        contentContainerStyle={{ padding: 12, gap: 12 }}
      >
        <Segmented
          value={String(tool)}
          options={[
            { value: String(AgentTool.BROWSER), label: "Browser" },
            { value: String(AgentTool.DESKTOP), label: "Desktop" },
            { value: String(AgentTool.DEVICE), label: "Device" },
          ]}
          onChange={(value) => onToolChange(Number(value))}
        />
        <SelectField
          label={tool === AgentTool.BROWSER ? "Browser tab" : tool === AgentTool.DEVICE ? "Device" : "Window"}
          hideLabel
          value={preview.targets.find((entry) => entry.id === targetId)?.label || "Choose a target"}
          disabled={!live || !preview.targets.length}
          onPress={() => setPicker(true)}
        />
        <PreviewControls
          key={`${tool}:${targetId}`}
          tool={tool}
          url={preview.url}
          enabled={live}
          input={preview.input}
        />
      </ScrollView>
      <PickerSheet
        title="Preview target"
        visible={picker}
        onClose={() => setPicker(false)}
        value={targetId}
        sections={[
          {
            options: preview.targets.map((entry) => ({
              value: entry.id,
              label: entry.label,
              description: entry.platform || entry.app,
            })),
          },
        ]}
        onSelect={chooseTarget}
      />
    </>
  );
}
