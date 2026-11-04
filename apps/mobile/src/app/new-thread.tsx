import { useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Redirect, router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Crypto from "expo-crypto";
import { Provider } from "@canopy/contracts";
import { useSession } from "../state/session";
import { useOverview } from "../state/overview";
import { useAppearance } from "../state/appearance";
import { Button, Field, Notice, ScreenHeader, Segmented } from "../ui/components";
import { ComposerBox } from "../features/threads/ComposerBox";
import { styles, useColors } from "../ui/theme";

export default function NewThread() {
  const c = useColors();
  const { session, client } = useSession();
  const { projects, workers } = useOverview();
  const settings = useAppearance();
  const [workspaceId, setWorkspaceId] = useState(settings.user?.threadDefaults?.workspaceId ?? "");
  const [provider, setProvider] = useState(String(settings.user?.threadDefaults?.provider || Provider.CODEX));
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(Crypto.randomUUID());
  const sending = useRef(false);

  if (!session) return <Redirect href="/pair" />;

  const workspaces = projects
    .filter((p) => !p.archivedAt)
    .flatMap((p) => p.workspaces.map((w) => ({ ...w, projectName: p.name })));

  const workspace =
    workspaces.find((w) => w.id === workspaceId) ??
    workspaces.find((w) => workers.find((worker) => worker.id === w.workerId)?.online);

  async function createThread() {
    if (!client || !workspace || sending.current) return;
    sending.current = true;
    setBusy(true);
    setError("");

    try {
      const result = await client.api.createThread(
        {
          projectId: workspace.projectId,
          workspaceId: workspace.id,
          provider: Number(provider),
          title,
          initialMessage: text,
          clientRequestId: requestId.current,
          permissionMode: settings.user?.threadDefaults?.permissionMode,
        },
        { timeoutMs: 20_000 },
      );

      if (result.thread)
        router.replace({
          pathname: "/thread/[id]",
          params: { id: result.thread.id },
        });
    } catch {
      setError("Could not create the thread. Check the worker and try again.");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.fill}>
      <ScreenHeader title="New thread" />
      <ScrollView
        contentContainerStyle={[styles.page, { paddingTop: 32, gap: 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={[styles.title, { color: c.text }]}>What would you like to do?</Text>
        <View style={{ gap: 8 }}>
          <Text style={[styles.label, { color: c.text }]}>Workspace</Text>
          {workspaces.map((w) => (
            <Button
              key={w.id}
              secondary
              title={`${workspace?.id === w.id ? "✓ " : ""}${w.projectName} · ${w.label || w.rootPath}`}
              onPress={() => setWorkspaceId(w.id)}
            />
          ))}
          {!workspace && <Notice>No workspace is available. Add one in Canopy on the web.</Notice>}
        </View>
        <Segmented
          options={[
            { value: String(Provider.CODEX), label: "Codex" },
            { value: String(Provider.CLAUDE), label: "Claude" },
            { value: String(Provider.GROK), label: "Grok" },
          ]}
          value={provider}
          onChange={setProvider}
        />
        <Field label="Title" value={title} onChangeText={setTitle} placeholder="Optional" />
        <ComposerBox
          text={text}
          onChange={setText}
          onSend={() => void createThread()}
          disabled={!workspace}
          busy={busy}
        />
        {error ? <Notice error>{error}</Notice> : null}
      </ScrollView>
    </SafeAreaView>
  );
}
