import { useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { Button, Notice, Sheet } from "../../ui/components";
import { SelectField } from "../../ui/Picker";
import { useColors, useTypography } from "../../ui/theme";
import { RefPickerSheet } from "../new-thread/WorkspacePickers";
import { useWorktreeContinuation } from "./useWorktreeContinuation";

/** Removed-directory state takes precedence over archived or imported history. */
export function RemovedWorktree({ thread }: { thread: ui.Thread }) {
  const state = useWorktreeContinuation(thread);
  const c = useColors();
  const type = useTypography();

  return (
    <View style={{ padding: 12, gap: 8 }}>
      <Text accessibilityRole="header" style={[type.body, { color: c.text }]}>
        This thread is read-only
      </Text>
      <Notice>Its worktree was removed. Continue in a new worktree with an excerpt of its history.</Notice>
      <Button title="Continue work" variant="primary" onPress={() => state.setVisible(true)} />
      <ContinuationSheet state={state} />
    </View>
  );
}

function ContinuationSheet({ state }: { state: ReturnType<typeof useWorktreeContinuation> }) {
  const [picker, setPicker] = useState(false);
  const [details, setDetails] = useState(false);
  const c = useColors();
  const type = useTypography();
  const disabled = Boolean(state.reason) || state.loading || state.busy;

  return (
    <>
      <Sheet
        title="Continue in a new worktree"
        visible={state.visible}
        onClose={() => {
          if (!state.busy) state.setVisible(false);
        }}
        snap
      >
        <Notice>A new thread receives an excerpt of this thread’s history. The source thread stays unchanged.</Notice>
        <Notice>Canopy does not restore local uncommitted files.</Notice>
        <SelectField
          label="Base ref"
          value={state.baseRef || "Choose a base ref"}
          disabled={disabled || state.attempted || !state.refs}
          onPress={() => setPicker(true)}
        />
        {state.loading && <Notice>Loading base refs…</Notice>}
        {state.reason && <Notice>{state.reason}</Notice>}
        {state.failure && <Notice error>{state.failure}</Notice>}
        {!!state.details && (
          <Button
            title={details ? "Hide details" : "Show details"}
            variant="ghost"
            onPress={() => setDetails((value) => !value)}
          />
        )}
        {details && !!state.details && (
          <Text selectable style={[type.meta, { color: c.muted }]}>
            {state.details}
          </Text>
        )}
        {!!state.failure && !state.attempted && (
          <Button title="Reload refs" variant="ghost" disabled={disabled} onPress={state.reload} />
        )}
        <Button
          title={state.attempted ? "Retry continuation" : "Create worktree"}
          variant="primary"
          busy={state.busy}
          disabled={disabled || !state.baseRef || (!state.attempted && !state.refs)}
          onPress={state.start}
        />
      </Sheet>
      <RefPickerSheet
        visible={state.visible && picker && !disabled && !state.attempted}
        onClose={() => setPicker(false)}
        refs={state.refs}
        value={state.baseRef}
        onSelect={state.setBaseRef}
      />
    </>
  );
}
