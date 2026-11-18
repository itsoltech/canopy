import { useState } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { github } from "@canopy/contracts";
import { Button, Notice } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import { useGitHubSignIn } from "./useGitHubSignIn";
import { useClock } from "../settings/display";

/** Inline account connection, reused by GitHub operations without automatically retrying mutations. */
export function ConnectGitHub({
  homeId = "",
  configured,
  hasAccounts = false,
  onconnected,
  style,
}: {
  homeId?: string;
  configured: boolean;
  hasAccounts?: boolean;
  onconnected?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useColors();
  const type = useTypography();
  const flow = useGitHubSignIn(homeId, onconnected);
  const attempt = flow.attempt;

  const terminal =
    attempt?.state === "connected"
      ? "GitHub account connected."
      : attempt?.state === "expired"
        ? "The code expired. Start again to get a new code."
        : attempt?.state === "denied"
          ? "GitHub sign-in was denied. You can try again when you are ready."
          : attempt?.state === "cancelled"
            ? "GitHub sign-in cancelled."
            : "GitHub sign-in could not finish. Start again to get a new code.";

  return (
    <View style={[{ gap: 12, minWidth: 0 }, style]}>
      {!configured ? (
        <Text style={[type.body, { color: c.muted }]}>
          GitHub account sign-in is not configured on this computer yet. Existing personal access tokens from Connectors
          can be used here when available.
        </Text>
      ) : attempt?.state === "pending" ? (
        <GitHubDeviceCode key={attempt.id} attempt={attempt} busy={flow.busy} onCancel={() => void flow.cancel()} />
      ) : (
        <View style={{ gap: 12 }}>
          {attempt && !(hasAccounts && attempt.state === "connected") && (
            <Text accessibilityLiveRegion="polite" style={[type.body, { color: c.soft }]}>
              {terminal}
            </Text>
          )}
          <Button
            title={flow.busy ? "Connecting…" : hasAccounts ? "Connect another account" : "Connect GitHub"}
            variant={hasAccounts ? "secondary" : "primary"}
            disabled={flow.busy}
            onPress={() => void flow.start()}
          />
        </View>
      )}
      {flow.error ? (
        <View style={{ gap: 8 }}>
          <Notice error>{flow.error}</Notice>
          <Button
            size="sm"
            title="Retry"
            onPress={() => {
              if (attempt?.state === "pending") flow.retry();
              else void flow.start();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

function GitHubDeviceCode({
  attempt,
  busy,
  onCancel,
}: {
  attempt: github.GitHubDeviceAuth;
  busy: boolean;
  onCancel: () => void;
}) {
  const c = useColors();
  const type = useTypography();
  const clock = useClock();
  const [copyStatus, setCopyStatus] = useState<"copied" | "failed">();
  const [openFailed, setOpenFailed] = useState(false);

  const verificationUri =
    attempt.verificationUri === "https://github.com/login/device" ? attempt.verificationUri : undefined;

  async function copyAndOpen() {
    try {
      const copied = await Clipboard.setStringAsync(attempt.userCode);
      setCopyStatus(copied ? "copied" : "failed");
    } catch {
      setCopyStatus("failed");
    }

    await openGitHub();
  }

  async function openGitHub() {
    if (!verificationUri) return;

    setOpenFailed(false);

    try {
      await Linking.openURL(verificationUri);
    } catch {
      setOpenFailed(true);
    }
  }

  return (
    <View style={{ gap: 12, padding: 16, borderRadius: 8, backgroundColor: c.well }}>
      <Text style={[type.body, { color: c.soft }]}>Enter this code on GitHub to connect your account.</Text>
      <Text
        selectable
        style={{
          fontSize: 24,
          fontFamily: type.mono.fontFamily,
          color: c.text,
          letterSpacing: 2,
        }}
      >
        {attempt.userCode}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {verificationUri && (
          <>
            <Button
              size="sm"
              variant="primary"
              title="Copy code and open GitHub"
              multiline
              onPress={() => void copyAndOpen()}
            />
            <Button size="sm" variant="ghost" title="Open GitHub" onPress={() => void openGitHub()} />
          </>
        )}
        <Button size="sm" title="Cancel" disabled={busy} onPress={onCancel} />
      </View>
      <Text accessibilityLiveRegion="polite" style={[type.body, { color: c.muted }]}>
        {copyStatus === "copied"
          ? "Code copied."
          : copyStatus === "failed"
            ? "Could not copy the code. Select and copy it."
            : "Waiting for GitHub."}{" "}
        Expires at {attempt.expiresAt ? clock.time(timestampDate(attempt.expiresAt)) : "—"}.
      </Text>
      {openFailed && <Notice error>Could not open GitHub. Open github.com/login/device in your browser.</Notice>}
    </View>
  );
}
