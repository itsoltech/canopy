import type { Ref } from "react";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { ShouldStartLoadRequest } from "react-native-webview/lib/WebViewTypes";

/** The shell document is the only load; its sandboxed srcdoc frame is the only subframe. Nothing navigates after. */
function allowInitialLoad(loaded: boolean) {
  return (request: ShouldStartLoadRequest) =>
    (!loaded && request.url === "about:blank") || (request.url === "about:srcdoc" && request.isTopFrame === false);
}

/**
 * The WebView every visual runs in, locked down (docs/agent-visuals.md §4): an inline HTML source with no base URL
 * (an opaque about:blank document), no file, content or universal access, incognito with no shared or third-party
 * cookies and no DOM storage, no windows, dialogs, media, zoom or link previews, no injected JavaScript and no
 * navigation after the first load. The only channel is `onMessage`, which the caller parses.
 */
export function SandboxedWebView({
  ref,
  html,
  height,
  loaded,
  onLoaded,
  onMessage,
  onFailure,
}: {
  ref: Ref<WebView<object>>;
  html: string;
  height: number;
  loaded: boolean;
  onLoaded: () => void;
  onMessage: (event: WebViewMessageEvent) => void;
  onFailure: () => void;
}) {
  return (
    <WebView
      ref={ref}
      source={{ html }}
      // Every URL reaches onShouldStartLoadWithRequest; the default list would hand other schemes to the system.
      originWhitelist={["*"]}
      onShouldStartLoadWithRequest={allowInitialLoad(loaded)}
      onLoadEnd={onLoaded}
      onMessage={onMessage}
      onOpenWindow={() => undefined}
      onError={onFailure}
      onRenderProcessGone={onFailure}
      onContentProcessDidTerminate={onFailure}
      javaScriptEnabled
      javaScriptCanOpenWindowsAutomatically={false}
      setSupportMultipleWindows={false}
      domStorageEnabled={false}
      incognito
      cacheEnabled={false}
      cacheMode="LOAD_NO_CACHE"
      sharedCookiesEnabled={false}
      thirdPartyCookiesEnabled={false}
      allowFileAccess={false}
      allowFileAccessFromFileURLs={false}
      allowUniversalAccessFromFileURLs={false}
      mixedContentMode="never"
      geolocationEnabled={false}
      mediaCapturePermissionGrantType="deny"
      allowsInlineMediaPlayback={false}
      mediaPlaybackRequiresUserAction
      allowsFullscreenVideo={false}
      allowsLinkPreview={false}
      allowsBackForwardNavigationGestures={false}
      dataDetectorTypes="none"
      saveFormDataDisabled
      paymentRequestEnabled={false}
      webviewDebuggingEnabled={false}
      setBuiltInZoomControls={false}
      textZoom={100}
      scrollEnabled={false}
      bounces={false}
      overScrollMode="never"
      nestedScrollEnabled
      style={{ height, backgroundColor: "transparent" }}
      containerStyle={{ flex: 0, height }}
    />
  );
}
