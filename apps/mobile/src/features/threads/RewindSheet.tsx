import { useState } from "react";
import { Text, View } from "react-native";
import { PickerSheet } from "../../ui/Picker";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import type { useThreadRewind } from "./useThreadRewind";

export function RewindSheet({ state }: { state: ReturnType<typeof useThreadRewind> }) {
  const c = useColors();
  const [details, setDetails] = useState(false);
  const preview = state.preview;

  const note = preview
    ? [
        `Rewind ${preview.messages} ${preview.messages === 1 ? "message" : "messages"} and edit this one. You can undo before sending again.`,
        preview.running || preview.backgroundTasks ? "The agent and its background tasks stop." : "",
        "Canopy cancels queued messages and pending requests.",
        preview.filesAvailable
          ? "Checkpoints cover the agent's file edits. Shell commands and subagents are excluded."
          : "Files stay as they are.",
      ]
        .filter(Boolean)
        .join("\n\n")
    : state.checking
      ? "Checking this message…"
      : state.error;

  return (
    <PickerSheet
      title={preview?.running ? "Stop and edit?" : "Edit from here?"}
      visible={Boolean(state.selected)}
      onClose={state.close}
      note={note}
      sections={[
        {
          options: preview
            ? [
                ...(preview.filesAvailable
                  ? [
                      {
                        value: true,
                        label: "Conversation and files",
                        icon: "arrow-uturn-left" as const,
                        disabled: state.busy,
                      },
                    ]
                  : []),
                {
                  value: false,
                  label: preview.filesAvailable
                    ? "Conversation only"
                    : preview.running
                      ? "Stop and edit"
                      : "Edit from here",
                  icon: "arrow-uturn-left" as const,
                  disabled: state.busy,
                },
              ]
            : [],
        },
      ]}
      onSelect={state.edit}
      footer={
        state.error && state.canRetry ? (
          <Button title="Retry" variant="ghost" onPress={state.retry} />
        ) : preview &&
          (preview.files.length > 0 || (preview.filesDetail && preview.filesDetail !== "Files stay as they are.")) ? (
          <View style={{ padding: 12, gap: 8 }}>
            <Button
              title={
                details
                  ? "Hide details"
                  : preview.files.length
                    ? `Show files to restore (${preview.files.length})`
                    : "Show details"
              }
              variant="ghost"
              onPress={() => setDetails(!details)}
            />
            {details ? (
              <Text style={[styles.meta, { color: c.muted }]}>
                {[...preview.files, preview.filesDetail].filter(Boolean).join("\n")}
              </Text>
            ) : null}
          </View>
        ) : undefined
      }
    />
  );
}
