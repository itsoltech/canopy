import { useEffect, useRef, useState, type ComponentRef } from "react";
import { ActivityIndicator, ScrollView, Text, View } from "react-native";
import type { CloneProgress as Progress } from "@canopy/contracts";
import { cloneProgressLabel } from "@canopy/domain/clone-progress";
import { Button } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";

export function CloneProgress({
  progress,
  busy,
  failed,
  capable,
  onCancel,
}: {
  progress: Progress | undefined;
  busy: boolean;
  failed: boolean;
  capable: boolean;
  onCancel?: (() => void) | undefined;
}) {
  const c = useColors();
  const type = useTypography();
  const [open, setOpen] = useState(false);
  const log = useRef<ComponentRef<typeof ScrollView>>(null);
  const lines = progress?.lines.join("\n") || "Waiting for Git…";
  useEffect(() => {
    if (failed) setOpen(true);
  }, [failed]);

  return (
    <View style={{ gap: 8 }}>
      <Text numberOfLines={2} accessibilityLiveRegion="polite" style={[type.body, { color: c.text, minHeight: 48 }]}>
        {cloneProgressLabel(progress)}
      </Text>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel="Clone progress"
        accessibilityValue={progress?.percent === undefined ? undefined : { min: 0, max: 100, now: progress.percent }}
        style={{ height: 6, backgroundColor: c.track, borderRadius: 3, overflow: "hidden" }}
      >
        <View style={{ height: 6, width: `${progress?.percent ?? 100}%`, backgroundColor: c.brand }} />
      </View>
      <View style={{ height: 24 }}>
        {busy && progress?.percent === undefined && <ActivityIndicator color={c.muted} accessibilityLabel="Cloning" />}
      </View>
      {capable && <Button title={open ? "Hide Git log" : "Show Git log"} onPress={() => setOpen(!open)} />}
      {capable && open && (
        <ScrollView
          ref={log}
          nestedScrollEnabled
          persistentScrollbar
          onContentSizeChange={() => log.current?.scrollToEnd({ animated: false })}
          style={{ height: 144, flexGrow: 0, backgroundColor: c.well, borderRadius: 6 }}
          contentContainerStyle={{ padding: 8, paddingRight: 20 }}
        >
          <Text selectable style={[type.mono, { color: c.soft }]}>
            {lines}
          </Text>
        </ScrollView>
      )}
      {busy && onCancel && <Button title="Cancel" onPress={onCancel} />}
    </View>
  );
}
