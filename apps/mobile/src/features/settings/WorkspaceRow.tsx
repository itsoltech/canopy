import { useState } from "react";
import { Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { ui } from "@canopy/contracts";
import { Button, Field, IconButton, Notice, Sheet } from "../../ui/components";
import { StatusDot } from "../../ui/Badge";
import { font, useColors, useTypography } from "../../ui/theme";
import { useOverview } from "../../state/overview";
import { useWorkerPresence } from "../computers/presence";
import { useSettingsAction, workersFollowStream, confirmAction, ResourceState } from "./resource";

export function WorkspaceRow({ workspace }: { workspace: ui.Workspace }) {
  const { workers } = useOverview();
  const worker = workers.find((w) => w.id === workspace.workerId);
  const presence = useWorkerPresence()(worker);
  const c = useColors();
  const type = useTypography();
  const resource = useSettingsAction(workersFollowStream);
  const [actions, setActions] = useState(false);
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState(workspace.rootPath);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const name = worker?.name || "Unknown worker";

  const os =
    worker?.os === "darwin"
      ? "macOS"
      : worker?.os === "win32"
        ? "Windows"
        : worker?.os === "linux"
          ? "Linux"
          : worker?.os;

  return (
    <>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, opacity: presence.online ? 1 : 0.55 }}>
        <StatusDot tone={presence.online ? "emerald" : "neutral"} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text numberOfLines={1} style={[type.chrome, { color: c.text, fontFamily: font.medium }]}>
            {name}
          </Text>
          <View style={{ flexDirection: "row", gap: 4 }}>
            <Text numberOfLines={1} style={[type.meta, { color: c.muted, flexShrink: 1 }]}>
              {[presence.computer, os].filter(Boolean).join(" · ")}
            </Text>
            {!presence.online && (
              <Text numberOfLines={1} style={[type.meta, { color: c.muted, maxWidth: "50%" }]}>
                · {presence.status}
              </Text>
            )}
          </View>
          <Text selectable numberOfLines={1} ellipsizeMode="middle" style={[type.mono, { color: c.muted }]}>
            {workspace.rootPath}
          </Text>
        </View>
        <IconButton
          icon="ellipsis-horizontal"
          label={`Workspace actions for ${name}`}
          onPress={() => setActions(true)}
        />
      </View>
      <Sheet title="Workspace actions" visible={actions} onClose={() => !resource.busy && setActions(false)}>
        <ResourceState resource={resource}>
          <Button
            title={copied ? "Copied" : "Copy path"}
            onPress={() =>
              void Clipboard.setStringAsync(workspace.rootPath).then(
                () => setCopied(true),
                () => setCopyError(true),
              )
            }
          />
          {copyError && <Notice error>Could not copy the path. Select it in the workspace row and copy it.</Notice>}
          <Button
            title="Edit path"
            disabled={!presence.online}
            onPress={() => {
              setActions(false);
              setPath(workspace.rootPath);
              setEditing(true);
            }}
          />
          <Button
            variant="danger"
            title="Remove workspace"
            busy={resource.busy}
            disabled={Boolean(worker?.nodeId) && !presence.online}
            onPress={() =>
              confirmAction(
                "Remove workspace",
                "New threads cannot use this workspace. Existing threads and files stay.",
                () =>
                  void resource
                    .run((api) => api.removeWorkspace({ workspaceId: workspace.id }))
                    .then((r) => {
                      if (r) setActions(false);
                    }),
              )
            }
          />
        </ResourceState>
      </Sheet>
      <Sheet title="Edit path" visible={editing} onClose={() => !resource.busy && setEditing(false)}>
        <ResourceState resource={resource}>
          <Field label="Directory path" value={path} onChangeText={setPath} autoCapitalize="none" autoCorrect={false} />
          <Notice>Existing threads keep their directory. New threads use the directory you choose.</Notice>
          <Button
            variant="primary"
            title="Save path"
            busy={resource.busy}
            disabled={!path.trim() || path === workspace.rootPath}
            onPress={() =>
              void resource
                .run((api) => api.updateWorkspace({ workspaceId: workspace.id, rootPath: path }))
                .then((r) => {
                  if (r) setEditing(false);
                })
            }
          />
        </ResourceState>
      </Sheet>
    </>
  );
}
