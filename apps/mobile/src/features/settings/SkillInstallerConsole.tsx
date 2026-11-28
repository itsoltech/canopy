import { useRef, useState, type ComponentRef } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { IconName } from "@canopy/ui/icons";
import { Button, Field, IconButton } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import type { SkillInstallerState } from "./skill-installer-session";

const status: Record<SkillInstallerState["phase"], string> = {
  starting: "Starting…",
  running: "Running",
  stopping: "Stopping…",
  stopped: "Stopped",
  finished: "Finished",
  failed: "Failed",
};

const directions: { icon: IconName; label: string; value: string }[] = [
  { icon: "chevron-left", label: "Left arrow", value: "\x1b[D" },
  { icon: "arrow-up", label: "Up arrow", value: "\x1b[A" },
  { icon: "arrow-down", label: "Down arrow", value: "\x1b[B" },
  { icon: "chevron-right", label: "Right arrow", value: "\x1b[C" },
];

const controlKeys = [
  { title: "Tab", label: "Tab", value: "\t" },
  { title: "Esc", label: "Escape", value: "\x1b" },
  { title: "Ctrl+C", label: "Control C", value: "\x03" },
];

export function SkillInstallerConsole({
  state,
  computer,
  active,
  onSend,
  onStop,
}: {
  state: SkillInstallerState;
  computer: string;
  active: boolean;
  onSend: (value: string) => boolean;
  onStop: () => void;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <View style={layout.stack}>
      <View style={layout.header}>
        <View style={layout.status}>
          <Text style={[type.chrome, { color: c.text }]} numberOfLines={2}>
            {computer}
          </Text>
          <Text accessibilityLiveRegion="polite" style={[type.meta, { color: c.muted }]}>
            {status[state.phase]}
          </Text>
        </View>
        {active && <Button title="Stop installer" size="sm" disabled={state.phase === "stopping"} onPress={onStop} />}
      </View>
      <InstallerOutput output={state.output} active={active} />
      {state.truncated && <Text style={[type.meta, { color: c.muted }]}>Showing recent installer output.</Text>}
      {state.phase === "running" && <InstallerInput writing={state.writing} onSend={onSend} />}
    </View>
  );
}

function InstallerOutput({ output, active }: { output: string; active: boolean }) {
  const c = useColors();
  const type = useTypography();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const follow = useRef(true);

  return (
    <ScrollView
      ref={scroll}
      accessibilityLabel="Installer output"
      nestedScrollEnabled
      keyboardShouldPersistTaps="handled"
      scrollEventThrottle={32}
      onScroll={({ nativeEvent }) => {
        follow.current =
          nativeEvent.contentOffset.y + nativeEvent.layoutMeasurement.height >= nativeEvent.contentSize.height - 24;
      }}
      onContentSizeChange={() => {
        if (follow.current) scroll.current?.scrollToEnd({ animated: false });
      }}
      style={[layout.output, { backgroundColor: c.inset, borderColor: c.line }]}
      contentContainerStyle={layout.outputContent}
    >
      <Text selectable style={[type.mono, { color: output ? c.text : c.muted }]}>
        {output || (active ? "Waiting for output…" : "No installer output")}
      </Text>
    </ScrollView>
  );
}

function InstallerInput({ writing, onSend }: { writing: boolean; onSend: (value: string) => boolean }) {
  const [answer, setAnswer] = useState("");

  function submit(text: string) {
    if (onSend(`${text}\r`)) setAnswer("");
  }

  return (
    <View style={layout.input}>
      <Field
        label="Answer"
        value={answer}
        onChangeText={setAnswer}
        onSubmitEditing={(event) => submit(event.nativeEvent.text)}
        autoCapitalize="none"
        autoCorrect={false}
        spellCheck={false}
        autoComplete="off"
        maxLength={4096}
        returnKeyType="send"
        submitBehavior="submit"
      />
      <View style={layout.keys}>
        <View style={layout.keyGroup}>
          {directions.map(({ icon, label, value }) => (
            <IconButton
              key={label}
              icon={icon}
              label={label}
              variant="secondary"
              size="sm"
              disabled={writing}
              onPress={() => onSend(value)}
            />
          ))}
        </View>
        <View style={layout.keyGroup}>
          {controlKeys.map(({ title, label, value }) => (
            <Button
              key={title}
              title={title}
              label={label}
              size="sm"
              disabled={writing}
              onPress={() => onSend(value)}
            />
          ))}
          <Button
            title="Enter"
            label="Send answer or press Enter"
            size="sm"
            disabled={writing}
            onPress={() => submit(answer)}
          />
        </View>
      </View>
    </View>
  );
}

const layout = StyleSheet.create({
  stack: { gap: 8 },
  header: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  status: { flexGrow: 1, flexShrink: 1, flexBasis: 96, gap: 2 },
  output: { height: 200, flexGrow: 0, borderWidth: 1, borderRadius: 8 },
  outputContent: { padding: 10 },
  input: { gap: 6 },
  keys: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  keyGroup: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
});
