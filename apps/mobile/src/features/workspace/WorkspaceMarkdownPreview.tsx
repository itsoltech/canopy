import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { randomUUID } from "expo-crypto";
import { useWindowDimensions, View } from "react-native";
import type { WebView, WebViewMessageEvent } from "react-native-webview";
import type { WorkspaceFile } from "@canopy/domain/workspace-file";
import { useAppearance } from "../../state/appearance";
import { themeOf } from "../settings/appearance";
import { useDevicePreferences } from "../settings/device-preferences";
import { SandboxedWebView } from "../visuals/SandboxedWebView";
import { useWorkspace } from "./context";
import { MarkdownPreviewState } from "./WorkspaceMarkdown";
import { markdownPreviewDocument } from "./markdown-preview-document";
import { handlePreviewMessage } from "./markdown-preview-actions";

export default function WorkspaceMarkdownPreview({ document, text }: { document: WorkspaceFile; text: string }) {
  const { appearance, dark } = useAppearance();
  const { values } = useDevicePreferences();
  const { fontScale } = useWindowDimensions();
  const path = document.path;
  const theme = themeOf(appearance, dark ? "dark" : "light");

  const source = useMemo(
    () => ({
      id: randomUUID(),
      html: markdownPreviewDocument({ text, path, theme, dark, fontScale, preferences: values }),
    }),
    [text, path, theme, dark, fontScale, values],
  );

  return <PreviewFrame key={source.id} document={document} html={source.html} />;
}

function PreviewFrame({ document, html }: { document: WorkspaceFile; html: string }) {
  const view = useWorkspace();
  const web = useRef<WebView<object>>(null);
  const session = useRef<AbortController | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useLayoutEffect(() => {
    const work = new AbortController();
    session.current = work;

    return () => work.abort();
  }, []);

  useEffect(() => {
    if (ready || failed) return;
    const timer = setTimeout(() => setFailed(true), 15_000);

    return () => clearTimeout(timer);
  }, [ready, failed]);

  function message(event: WebViewMessageEvent) {
    const signal = session.current?.signal;

    if (!signal || signal.aborted) return;

    void handlePreviewMessage(event.nativeEvent.data, document, view, signal, () => setReady(true)).then((reply) => {
      if (reply && !signal.aborted) web.current?.postMessage(reply);
    });
  }

  if (failed) return <MarkdownPreviewState failed />;

  return (
    <View style={{ flex: 1 }}>
      {!ready && <MarkdownPreviewState />}
      <SandboxedWebView
        ref={web}
        html={html}
        loaded={loaded}
        onLoaded={() => setLoaded(true)}
        onMessage={message}
        onFailure={() => {
          session.current?.abort();
          setFailed(true);
        }}
      />
    </View>
  );
}
