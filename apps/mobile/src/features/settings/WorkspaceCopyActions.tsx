import { Text, View } from "react-native";
import { copySize, copyFileCount } from "@canopy/domain/workspace-copy";
import { Button, Notice } from "../../ui/components";
import { Checkbox } from "../../ui/Checkbox";
import { useColors, useTypography } from "../../ui/theme";
import type { useWorkspaceCopy } from "./use-workspace-copy";

/** Outside the scrolling preview: the copy action and its reason always remain visible. */
export function WorkspaceCopyActions({
  state,
  workerName,
  onSaved,
}: {
  state: ReturnType<typeof useWorkspaceCopy>;
  workerName: string;
  onSaved: () => void;
}) {
  const c = useColors();
  const type = useTypography();

  const {
    manifest,
    loading,
    busy,
    progress,
    error,
    cancelled,
    confirming,
    confirmed,
    disabledReason,
    totals,
    skipped,
  } = state;

  let action;

  if (!manifest && !error && !cancelled) return null;

  if (loading) action = <Button variant="primary" title="Reading file list…" busy onPress={() => {}} />;
  else if (progress?.status === "completed") action = <Button variant="primary" title="Done" onPress={onSaved} />;
  else if (busy)
    action = (
      <>
        <Button variant="primary" title="Copying workspace…" busy onPress={() => {}} />
        <Button title="Cancel copy" onPress={state.cancel} />
      </>
    );
  else if (error || cancelled)
    action = <Button variant="primary" title="Refresh file list" onPress={() => void state.load()} />;
  else
    action = (
      <>
        {confirming ? (
          <>
            <Checkbox
              label={`I want to copy these files to ${workerName}`}
              checked={confirmed}
              onChange={state.setConfirmed}
            />
            {!confirmed && <Notice>Confirm the files above to continue.</Notice>}
          </>
        ) : (
          <Text style={[type.body, { color: c.text, fontVariant: ["tabular-nums"] }]}>
            {`${copyFileCount(totals.files)} · ${copySize(totals.bytes)} selected · ${skipped.toLocaleString()} skipped`}
          </Text>
        )}
        {!!disabledReason && <Notice>{disabledReason}</Notice>}
        <Button
          variant="primary"
          title={confirming ? "Copy these files" : state.secrets.length ? "Review secrets" : "Copy workspace"}
          disabled={!!disabledReason || (confirming && !confirmed)}
          onPress={() => void state.copy()}
        />
        {confirming && (
          <Button
            title="Back to files"
            onPress={() => {
              state.setConfirming(false);
              state.setConfirmed(false);
            }}
          />
        )}
      </>
    );

  return (
    <View
      style={{
        flexShrink: 0,
        borderTopWidth: 1,
        borderTopColor: c.line,
        paddingTop: 12,
        gap: 12,
        backgroundColor: c.surface,
      }}
    >
      {action}
    </View>
  );
}
