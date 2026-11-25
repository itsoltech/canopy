import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { AgentTool, type AgentPreviewInput, type AgentPreviewTarget } from "@canopy/contracts";
import type { IconName } from "@canopy/ui/icons";
import { Button, IconButton } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { PickerSheet } from "../../ui/Picker";
import { Segmented } from "../../ui/Segmented";
import { styles, useColors } from "../../ui/theme";
import { PreviewEditor, type PreviewEditorKind } from "./PreviewEditor";
import { previewCommands, sendPreviewInputs } from "./preview-commands";
import type { useAgentPreview } from "./useAgentPreview";

const sources = [
  { value: String(AgentTool.BROWSER), label: "Browser", icon: "globe-alt" },
  { value: String(AgentTool.DESKTOP), label: "Desktop", icon: "computer-desktop" },
  { value: String(AgentTool.DEVICE), label: "Device", icon: "device-mobile" },
] as const;

export function PreviewToolbar({
  preview,
  tool,
  targetId,
  computer,
  live,
  compact,
  visible,
  editing,
  editorScope,
  onEdit,
  onCloseEditor,
  onToolChange,
  onTargetChange,
}: {
  preview: ReturnType<typeof useAgentPreview>;
  tool: AgentTool;
  targetId: string;
  computer?: string;
  live: boolean;
  compact: boolean;
  visible: boolean;
  editing?: PreviewEditorKind;
  editorScope: string;
  onEdit: (value: PreviewEditorKind) => void;
  onCloseEditor: () => void;
  onToolChange: (tool: AgentTool) => void;
  onTargetChange: (target: AgentPreviewTarget | undefined) => void;
}) {
  const c = useColors();
  const [sheet, setSheet] = useState<"source" | "commands">();
  const browser = tool === AgentTool.BROWSER;
  const target = preview.targets.find((entry) => entry.id === targetId);
  const closeSheet = () => setSheet(undefined);

  function chooseTarget(id: string) {
    if (!live) return;

    if (browser) sendPreviewInputs(preview.input, [{ kind: "tab", text: id }]);
    else onTargetChange(preview.targets.find((entry) => entry.id === id));
  }

  return (
    <>
      <View
        style={[
          {
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderTopWidth: 1,
            borderColor: c.rule,
            backgroundColor: c.background,
          },
          !visible && { display: "none" },
        ]}
      >
        <PreviewEditor
          key={editorScope}
          kind={visible ? editing : undefined}
          url={preview.url}
          enabled={live}
          input={preview.input}
          onClose={onCloseEditor}
        />
        {!editing && (
          <PreviewToolbarRows
            preview={preview}
            tool={tool}
            targetLabel={target?.label || preview.title}
            live={live}
            compact={compact}
            sourceOpen={sheet === "source"}
            onSource={() => setSheet("source")}
            onMore={() => setSheet("commands")}
            onEdit={onEdit}
          />
        )}
      </View>
      <PickerSheet
        title="Preview source"
        visible={visible && sheet === "source"}
        onClose={closeSheet}
        value={targetId}
        header={
          <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
            <Segmented value={String(tool)} options={sources} onChange={(value) => onToolChange(Number(value))} />
          </View>
        }
        sections={[
          {
            options: preview.targets.map((entry) => ({
              value: entry.id,
              label: entry.label,
              description: entry.platform || entry.app,
              disabled: !live,
            })),
          },
        ]}
        note={computer}
        onSelect={chooseTarget}
      />
      <PreviewCommandSheet
        tool={tool}
        input={preview.input}
        live={live}
        visible={visible && sheet === "commands"}
        onClose={closeSheet}
      />
    </>
  );
}

function PreviewCommandSheet({
  tool,
  input,
  live,
  visible,
  onClose,
}: {
  tool: AgentTool;
  input: (value: AgentPreviewInput) => void;
  live: boolean;
  visible: boolean;
  onClose: () => void;
}) {
  const { more } = previewCommands(tool);

  return (
    <PickerSheet
      title="More controls"
      visible={visible}
      onClose={onClose}
      sections={[
        {
          options: more.map((command) => ({
            value: command.label,
            label: command.label,
            icon: command.icon,
            disabled: !live,
          })),
        },
      ]}
      onSelect={(label) => {
        const command = more.find((entry) => entry.label === label);

        if (live && command) sendPreviewInputs(input, command.inputs);
      }}
    />
  );
}

function PreviewToolbarRows({
  preview,
  tool,
  targetLabel,
  live,
  compact,
  sourceOpen,
  onSource,
  onMore,
  onEdit,
}: {
  preview: ReturnType<typeof useAgentPreview>;
  tool: AgentTool;
  targetLabel: string;
  live: boolean;
  compact: boolean;
  sourceOpen: boolean;
  onSource: () => void;
  onMore: () => void;
  onEdit: (value: PreviewEditorKind) => void;
}) {
  const c = useColors();
  const browser = tool === AgentTool.BROWSER;
  const source = sources.find((entry) => entry.value === String(tool)) ?? sources[0];

  return (
    <View style={compact ? [styles.row, { gap: 12 }] : { gap: 2 }}>
      <View style={[styles.row, { gap: 6, minWidth: 0, flex: compact ? 1 : undefined }]}>
        <ToolbarField
          label="Choose preview source"
          value={browser ? source.label : targetLabel || source.label}
          icon={source.icon}
          choose
          flexible={!browser}
          expanded={sourceOpen}
          onPress={onSource}
        />
        {browser && (
          <View
            style={[
              styles.row,
              {
                flex: 1,
                minWidth: 0,
                gap: 0,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: c.rule,
                backgroundColor: c.control,
              },
            ]}
          >
            <ToolbarField
              label="Edit page address"
              value={preview.url.replace(/^https?:\/\//, "") || targetLabel || "Page address"}
              flexible
              disabled={!live}
              onPress={() => onEdit("address")}
            />
            <IconButton
              icon="arrow-path"
              label="Reload page"
              disabled={!live}
              onPress={() => sendPreviewInputs(preview.input, [{ kind: "reload" }])}
            />
          </View>
        )}
      </View>
      <View style={[styles.row, { justifyContent: "space-between", gap: 4 }]}>
        <View style={[styles.row, { gap: 4 }]}>
          {previewCommands(tool).quick.map((command) => {
            const onPress = () => sendPreviewInputs(preview.input, command.inputs);

            return command.icon ? (
              <IconButton
                key={command.label}
                icon={command.icon}
                label={command.label}
                disabled={!live}
                onPress={onPress}
              />
            ) : (
              <Button
                key={command.label}
                title={command.label}
                size="sm"
                variant="ghost"
                disabled={!live}
                onPress={onPress}
              />
            );
          })}
        </View>
        <View style={[styles.row, { gap: 4 }]}>
          <IconButton icon="keyboard" label="Type text" disabled={!live} onPress={() => onEdit("text")} />
          <IconButton icon="ellipsis-horizontal" label="Show more controls" disabled={!live} onPress={onMore} />
        </View>
      </View>
    </View>
  );
}

function ToolbarField({
  label,
  value,
  icon,
  choose,
  expanded,
  flexible,
  disabled,
  onPress,
}: {
  label: string;
  value: string;
  icon?: IconName;
  choose?: boolean;
  expanded?: boolean;
  flexible?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const c = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${value}`}
      accessibilityState={{ disabled, expanded }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          flex: flexible ? 1 : undefined,
          minHeight: 44,
          minWidth: 0,
          gap: 6,
          paddingHorizontal: 10,
          borderRadius: 10,
          borderWidth: choose ? 1 : 0,
          borderColor: c.rule,
          backgroundColor: pressed ? c.pressed : choose ? c.control : "transparent",
        },
      ]}
    >
      {icon && <Icon name={icon} color={c.icon} />}
      <Text
        numberOfLines={1}
        ellipsizeMode={choose ? "tail" : "middle"}
        style={[styles.chrome, { flex: flexible ? 1 : undefined, color: disabled ? c.muted : c.text }]}
      >
        {value}
      </Text>
      {choose && <Icon name="chevron-down" size={12} color={c.icon} />}
    </Pressable>
  );
}
