import { useEffect, useState } from "react";
import { ScrollView, Text } from "react-native";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { SettingChoice, SettingsGroup } from "./SettingsGroup";
import { createSettingsViewState } from "./SettingsScroll";

const usePreviewFile = createSettingsViewState("claude");
const usePreviewDestination = createSettingsViewState("platform");

export function EnvironmentPreview({
  worker,
  draft,
}: {
  worker: ui.EnvironmentWorker;
  draft?: ui.InstructionDocument;
}) {
  const { client } = useSession();
  const scope = `${draft ? "draft" : "saved"}:${worker.workerId}`;
  const [harness, setHarness] = usePreviewFile(scope);
  const [destination, setDestination] = usePreviewDestination(scope);
  const [attempt, setAttempt] = useState(0);

  const [result, setResult] = useState<{
    draft: ui.InstructionDocument;
    workerId: string;
    attempt: number;
    preview?: ui.PreviewAgentEnvironmentResponse;
  }>();

  const c = useColors();
  const workerId = worker.workerId;
  useEffect(() => {
    if (!draft || !client) return;
    const controller = new AbortController();

    const timer = setTimeout(() => {
      void client.api.previewAgentEnvironment({ workerId, draft }, { signal: controller.signal }).then(
        (preview) => {
          if (!controller.signal.aborted) setResult({ draft, workerId, attempt, preview });
        },
        () => {
          if (!controller.signal.aborted) setResult({ draft, workerId, attempt });
        },
      );
    }, 300);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, draft, workerId, attempt]);

  const current =
    result && result.draft === draft && result.workerId === workerId && result.attempt === attempt ? result : undefined;

  const instructions = draft ? current?.preview?.instructions : worker.preview;

  const item = instructions?.find(
    (row) => row.harness === harness && (destination === "device" ? row.deviceHome : row.platformHome),
  );

  return (
    <SettingsGroup title="Live preview" description={draft ? "Unsaved draft" : "Saved library"}>
      <SettingChoice
        title="Agent file"
        compact
        value={harness}
        onChange={setHarness}
        options={[
          { value: "claude", label: "CLAUDE.md" },
          { value: "codex", label: "AGENTS.md" },
        ]}
      />
      <SettingChoice
        title="Destination"
        compact
        value={destination}
        onChange={setDestination}
        options={[
          { value: "platform", label: "Canopy sessions" },
          { value: "device", label: "Device CLI" },
        ]}
      />
      {draft && !current ? (
        <Text accessibilityLiveRegion="polite" style={[styles.workMeta, { color: c.muted }]}>
          Updating preview…
        </Text>
      ) : current && !current.preview ? (
        <>
          <Notice error>Could not update the preview. Check the connection and retry.</Notice>
          <Button title="Retry" onPress={() => setAttempt((value) => value + 1)} />
        </>
      ) : (
        <>
          <ScrollView key={`${harness}:${destination}`} nestedScrollEnabled style={{ maxHeight: 384 }}>
            <Text selectable style={[styles.chrome, { color: item?.content ? c.text : c.muted }]}>
              {item?.content || "Add a document and assign it to see what agents receive."}
            </Text>
          </ScrollView>
          <Text style={[styles.workMeta, { color: c.muted }]}>
            {new TextEncoder().encode(item?.content ?? "").length.toLocaleString()} / 24,576 bytes · Local text outside
            Canopy’s block stays on the computer.
          </Text>
        </>
      )}
    </SettingsGroup>
  );
}
