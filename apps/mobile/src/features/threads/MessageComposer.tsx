import { useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { PermissionMode, ui, type ProfileModels } from "@open-agents/contracts";
import { useSession } from "../../state/session";
import { ComposerBox, ComposerPill } from "./ComposerBox";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { useAppearance } from "../../state/appearance";

export const permissionLabels: Record<number, string> = {
  0: "Ask first",
  1: "Ask first",
  2: "Accept edits",
  3: "Read only",
  4: "Full auto",
};
export function MessageComposer({
  thread,
  worker,
  text,
  onChange,
  send,
  stop,
  disabled,
  busy,
  onDetails,
}: {
  thread?: ui.Thread;
  worker?: ui.Worker;
  text: string;
  onChange: (text: string) => void;
  send: (delivery: ui.MessageDelivery) => void;
  stop: () => void;
  disabled: boolean;
  busy: boolean;
  onDetails: () => void;
}) {
  const c = useColors();
  const { client } = useSession();
  const { user } = useAppearance();
  const [sheet, setSheet] = useState<"model" | "permission" | "goal" | null>(
    null,
  );
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [catalog, setCatalog] = useState<ProfileModels[]>([]);
  useEffect(() => {
    let active = true;
    if (client && thread?.workerId)
      void client.api
        .listModels({ workerId: thread.workerId })
        .then((r) => {
          if (active) setCatalog(r.workers.flatMap((w) => w.profiles));
        })
        .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [client, thread?.workerId]);
  const models =
    catalog.find(
      (p) =>
        p.provider === thread?.provider &&
        (p.profileId || "native") === (thread?.providerProfileId || "native"),
    )?.models ?? [];
  const currentModel =
    models.find((m) => m.id === thread?.model) ??
    (!thread?.model ? models.find((m) => m.isDefault) : undefined);
  const currentEffort = thread?.effort || currentModel?.defaultEffort || "";
  async function update(patch: {
    model?: string;
    effort?: string;
    permissionMode?: PermissionMode;
  }) {
    if (!client || !thread) return;
    setSaving(true);
    setError("");
    try {
      await client.api.updateThread({ threadId: thread.id, ...patch });
      setSheet(null);
    } catch {
      setError("Could not update the thread. Try again.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <ComposerBox
        text={text}
        onChange={onChange}
        onSend={() =>
          send(
            thread?.status === "running"
              ? user?.composer?.runningDelivery || ui.MessageDelivery.STEER
              : ui.MessageDelivery.QUEUE,
          )
        }
        onQueue={() => send(ui.MessageDelivery.QUEUE)}
        onStop={stop}
        running={thread?.status === "running"}
        disabled={disabled}
        busy={busy}
        controls={
          <>
            <ComposerPill
              icon="flag"
              title="Goal"
              onPress={() => setSheet("goal")}
            />
            <ComposerPill
              icon="cpu-chip"
              leading={
                thread ? <ProviderIcon provider={thread.provider} /> : undefined
              }
              title={
                currentModel?.displayName || thread?.model || "Default model"
              }
              onPress={() => {
                setModel(thread?.model ?? "");
                setEffort(thread?.effort ?? "");
                setError("");
                setSheet("model");
              }}
            />
            {currentEffort && (
              <ComposerPill
                icon="light-bulb"
                title={currentEffort[0]!.toUpperCase() + currentEffort.slice(1)}
                onPress={() => {
                  setModel(thread?.model ?? "");
                  setEffort(thread?.effort ?? "");
                  setSheet("model");
                }}
              />
            )}
          </>
        }
      />
      <View
        style={{
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
          paddingHorizontal: 6,
        }}
      >
        <ComposerPill
          icon="computer-desktop"
          title={worker?.name ?? "Worker"}
          onPress={onDetails}
        />
        <ComposerPill
          icon={
            thread?.permissionMode === PermissionMode.FULL_AUTO
              ? "shield-exclamation"
              : "shield-check"
          }
          title={permissionLabels[thread?.permissionMode ?? 0] ?? "Ask first"}
          warning={thread?.permissionMode === PermissionMode.FULL_AUTO}
          onPress={() => setSheet("permission")}
        />
      </View>
      <Sheet
        visible={sheet !== null}
        title={
          sheet === "model"
            ? "Model and effort"
            : sheet === "permission"
              ? "Permissions"
              : "Goal"
        }
        onClose={() => setSheet(null)}
      >
        {sheet === "model" && (
          <>
            {models
              .filter((m) => !m.hidden)
              .map((m) => (
                <Button
                  key={m.id}
                  secondary
                  title={m.displayName || m.id}
                  onPress={() => setModel(m.id)}
                />
              ))}
            <Field
              label="Model"
              value={model}
              onChangeText={setModel}
              placeholder="Default model"
              autoCapitalize="none"
            />
            <Field
              label="Effort"
              value={effort}
              onChangeText={setEffort}
              placeholder="Default effort"
              autoCapitalize="none"
            />
            <Text style={[styles.meta, { color: c.muted }]}>
              These defaults apply to the next turn.
            </Text>
            <Button
              title="Save"
              busy={saving}
              onPress={() =>
                void update({ model: model.trim(), effort: effort.trim() })
              }
            />
          </>
        )}
        {sheet === "permission" && (
          <View style={{ gap: 12 }}>
            {[
              PermissionMode.ASK,
              PermissionMode.ACCEPT_EDITS,
              PermissionMode.READ_ONLY,
              PermissionMode.FULL_AUTO,
            ].map((mode) => (
              <Button
                key={mode}
                title={permissionLabels[mode]!}
                secondary
                busy={saving}
                onPress={() =>
                  mode === PermissionMode.FULL_AUTO
                    ? Alert.alert(
                        "Full auto",
                        "Runs without asking, sandboxed to the workspace.",
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Use Full auto",
                            onPress: () =>
                              void update({ permissionMode: mode }),
                          },
                        ],
                      )
                    : void update({ permissionMode: mode })
                }
              />
            ))}
          </View>
        )}
        {sheet === "goal" && (
          <>
            <Text style={[styles.body, { color: c.text }]}>
              {thread?.goalStatus
                ? `Goal · ${thread.goalStatus}`
                : "No active goal"}
            </Text>
            <Text style={[styles.meta, { color: c.muted }]}>
              Manage goals in Canopy on the web.
            </Text>
          </>
        )}
        {error ? <Notice error>{error}</Notice> : null}
      </Sheet>
    </>
  );
}
