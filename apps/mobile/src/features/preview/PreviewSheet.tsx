import { useState, type ReactNode } from "react";
import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import { create } from "@bufbuild/protobuf";
import { AgentPreviewInputSchema, AgentTool, type AgentPreviewTarget, type ui } from "@canopy/contracts";
import { Sheet } from "../../ui/components";
import { Button } from "../../ui/Button";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { Segmented } from "../../ui/Segmented";
import { styles, useColors } from "../../ui/theme";
import { useSession } from "../../state/session";
import { useCopyText } from "../viewers/useCopyText";
import { PreviewCanvas } from "./PreviewCanvas";
import { PreviewControls } from "./PreviewControls";
import { useAgentPreview } from "./useAgentPreview";

export function PreviewSheet({
  threadId,
  worker,
  visible,
  offline,
  onClose,
}: {
  threadId: string;
  worker?: ui.Worker;
  visible: boolean;
  offline: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet title="Preview" visible={visible} onClose={onClose} scroll={false}>
      {visible && <PreviewBody key={threadId} threadId={threadId} worker={worker} offline={offline} />}
    </Sheet>
  );
}

function PreviewBody({ threadId, worker, offline }: { threadId: string; worker?: ui.Worker; offline: boolean }) {
  const c = useColors();
  const { height } = useWindowDimensions();
  const compact = height < 500;
  const { online } = useSession();
  const [tool, setTool] = useState(AgentTool.BROWSER);
  const [target, setTarget] = useState<AgentPreviewTarget>();
  const [picker, setPicker] = useState(false);
  const item = worker?.agentTools.find((entry) => entry.tool?.tool === tool);

  const ready =
    tool === AgentTool.DEVICE
      ? item?.tool?.installed && item.tool.version === "0.21.37" && item.tool.install?.state !== "running"
      : item?.tool?.ready;

  const unavailable = offline || !online || !worker?.online;
  const allowed = !unavailable && Boolean(item?.enabled && ready && !item.blockedReason);
  const preview = useAgentPreview({ threadId, tool, target, enabled: allowed });
  const live = allowed && ["ready", "frame"].includes(preview.state);
  const failed = ["error", "closed"].includes(preview.state);
  const targetId = target?.id || preview.targetId;

  function chooseTarget(id: string) {
    const next = preview.targets.find((entry) => entry.id === id);

    if (tool === AgentTool.BROWSER) preview.input(create(AgentPreviewInputSchema, { kind: "tab", text: id }));
    else setTarget(next);
  }

  return (
    <PreviewLayout compact={compact}>
      <PreviewToolPicker
        tool={tool}
        onChange={(value) => {
          setTool(value);
          setTarget(undefined);
        }}
      />
      <PreviewStatus
        unavailable={unavailable}
        allowed={allowed}
        failed={failed}
        live={live}
        frame={Boolean(preview.frame)}
      />
      {allowed ? (
        <>
          {preview.targets.length > 0 && (
            <SelectField
              label={tool === AgentTool.BROWSER ? "Browser tab" : tool === AgentTool.DEVICE ? "Device" : "Window"}
              hideLabel
              value={preview.targets.find((entry) => entry.id === targetId)?.label || "Choose a target"}
              disabled={!live}
              onPress={() => setPicker(true)}
            />
          )}
          {failed ? (
            <PreviewFailure detail={preview.detail} retry={preview.retry} />
          ) : (
            <>
              <View style={compact ? { height: Math.max(160, height / 2) } : { flex: 1, minHeight: 80 }}>
                <PreviewCanvas
                  key={`${tool}:${targetId}`}
                  frame={preview.frame}
                  uri={preview.uri}
                  enabled={live}
                  input={preview.input}
                />
              </View>
              {preview.notice ? (
                <Text accessibilityLiveRegion="polite" style={[styles.overlayMeta, { color: c.muted }]}>
                  {preview.notice}
                </Text>
              ) : null}
              <ScrollView
                keyboardShouldPersistTaps="handled"
                scrollEnabled={!compact}
                style={{ flexGrow: 0, flexShrink: 1, maxHeight: compact ? undefined : "45%" }}
              >
                <PreviewControls
                  key={`${tool}:${targetId}`}
                  tool={tool}
                  url={preview.url}
                  enabled={live}
                  input={preview.input}
                />
              </ScrollView>
            </>
          )}
        </>
      ) : (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <Text style={[styles.overlay, { color: c.muted }]}>
            {unavailable
              ? "Reconnect this computer and device to open a live preview."
              : !item?.enabled
                ? "Allow agent access to this tool in Settings → Workers on web or desktop, then reopen Preview."
                : "Check this tool in Settings → Workers on web or desktop, then reopen Preview."}
          </Text>
        </View>
      )}
      <Text numberOfLines={1} style={[styles.overlayMeta, { color: c.muted }]}>
        {worker?.name || "Computer"}
        {preview.title ? ` · ${preview.title}` : ""}
      </Text>
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
    </PreviewLayout>
  );
}

function PreviewToolPicker({ tool, onChange }: { tool: AgentTool; onChange: (tool: AgentTool) => void }) {
  return (
    <Segmented
      value={String(tool)}
      options={[
        { value: String(AgentTool.BROWSER), label: "Browser" },
        { value: String(AgentTool.DESKTOP), label: "Desktop" },
        { value: String(AgentTool.DEVICE), label: "Device" },
      ]}
      onChange={(value) => onChange(Number(value))}
    />
  );
}

/** Short windows scroll the image and controls together, without shrinking either over its neighbours. */
function PreviewLayout({ compact, children }: { compact: boolean; children: ReactNode }) {
  return compact ? (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 12, gap: 12 }}>
      {children}
    </ScrollView>
  ) : (
    <View style={{ flex: 1, minHeight: 0, padding: 12, gap: 12 }}>{children}</View>
  );
}

function PreviewFailure({ detail, retry }: { detail: string; retry: () => void }) {
  const c = useColors();
  const [details, setDetails] = useState(false);
  const { copy } = useCopyText(detail);

  return (
    <View style={{ flex: 1, justifyContent: "center", gap: 12 }}>
      <Text style={[styles.overlay, { color: c.text }]}>Preview unavailable</Text>
      <Text style={[styles.overlay, { color: c.muted }]}>Check the connection and tool status, then retry.</Text>
      <Button title="Retry preview" onPress={retry} />
      {detail && (
        <Button
          title={details ? "Hide details" : "Show details"}
          variant="ghost"
          onPress={() => setDetails(!details)}
        />
      )}
      {details && (
        <>
          <Text selectable style={[styles.overlayMeta, { color: c.muted }]}>
            {detail}
          </Text>
          <Button title="Copy details" variant="ghost" onPress={() => void copy()} />
        </>
      )}
    </View>
  );
}

function PreviewStatus({
  unavailable,
  allowed,
  failed,
  live,
  frame,
}: {
  unavailable: boolean;
  allowed: boolean;
  failed: boolean;
  live: boolean;
  frame: boolean;
}) {
  const c = useColors();

  const status = unavailable
    ? "Offline"
    : !allowed
      ? "Not ready"
      : failed
        ? "Disconnected"
        : live
          ? frame
            ? "Live"
            : "Waiting"
          : "Connecting…";

  return (
    <Text accessibilityLiveRegion="polite" style={[styles.overlayMeta, { color: c.muted }]}>
      {status}
    </Text>
  );
}
