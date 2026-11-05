import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { ShellResult } from "@canopy/contracts";
import { Icon } from "./Icon";
import { styles, useColors } from "./theme";

/** A command the user ran in the thread's shell (composer shell mode), with its exit status and output. */
export function ShellMessage({
  command,
  result,
  status,
  error,
}: {
  command: string;
  result?: ShellResult;
  status: string;
  /** The turn's error when it failed before the command ran. */
  error?: string;
}) {
  const c = useColors();
  const [expanded, setExpanded] = useState(false);
  const state = result?.status ?? status;
  const running = state === "running";
  const success = result?.status === "completed" && result.exitCode === 0;
  const lines = result?.output.split("\n") ?? [];
  const reason = result?.reason || (state === "failed" ? error : "");

  const label = running
    ? "Running…"
    : state === "interrupted"
      ? "Interrupted"
      : state === "failed"
        ? "Failed"
        : result?.exitCode !== undefined
          ? `Exit ${result.exitCode}`
          : "Queued";

  return (
    <View style={{ alignItems: "flex-end" }}>
      <View
        style={{
          width: "95%",
          gap: 8,
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderRadius: 16,
          borderBottomRightRadius: 6,
          borderWidth: 1,
          borderColor: `${c.danger}40`,
          backgroundColor: `${c.danger}0d`,
        }}
      >
        <View style={[styles.row, { justifyContent: "space-between" }]}>
          <View style={[styles.row, { gap: 6 }]}>
            <Icon name="command-line" size={14} color={c.danger} />
            <Text style={[styles.caption, { color: c.danger }]}>Shell command</Text>
          </View>
          <View
            accessibilityRole="text"
            style={[
              styles.row,
              { gap: 4, paddingHorizontal: 6, borderRadius: 6, backgroundColor: `${success ? c.success : c.danger}1a` },
            ]}
          >
            {running && <ActivityIndicator size="small" color={c.danger} />}
            <Text style={[styles.caption, { color: success ? c.success : c.danger }]}>{label}</Text>
          </View>
        </View>
        <Text selectable style={[styles.workMeta, { color: c.text, fontFamily: "monospace" }]}>
          {command}
        </Text>
        {reason ? <Text style={[styles.caption, { color: c.danger }]}>{reason}</Text> : null}
        {result && !running ? (
          result.output ? (
            <>
              <Text
                selectable
                numberOfLines={expanded ? undefined : 4}
                style={[styles.caption, { color: c.muted, fontFamily: "monospace" }]}
              >
                {(expanded ? result.output : lines.slice(0, 4).join("\n")).slice(0, 12000)}
              </Text>
              {lines.length > 4 || result.output.length > 400 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ expanded }}
                  onPress={() => setExpanded(!expanded)}
                  style={{ minHeight: 32, justifyContent: "center" }}
                >
                  <Text style={[styles.caption, { color: c.danger }]}>{expanded ? "Hide output" : "Show output"}</Text>
                </Pressable>
              ) : null}
            </>
          ) : (
            <Text style={[styles.caption, { color: c.muted }]}>No output</Text>
          )
        ) : null}
      </View>
    </View>
  );
}
