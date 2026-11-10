import { useState } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { timestampDate } from "@bufbuild/protobuf/wkt";
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
  const clock = useClock();
  const flow = useGitHubSignIn(homeId, onconnected);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const attempt = flow.attempt;

  async function copy() {
    setError("");

    try {
      await Clipboard.setStringAsync(attempt?.userCode ?? "");
      setCopied(true);
    } catch {
      setError("Could not copy the code. Select it and copy it manually.");
    }
  }

  async function open() {
    if (attempt?.verificationUri !== "https://github.com/login/device") return;

    setError("");

    try {
      await Linking.openURL(attempt.verificationUri);
    } catch {
      setError("Could not open GitHub. Open github.com/login/device in your browser.");
    }
  }

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
            <Button size="sm" title="Copy code" onPress={() => void copy()} />
            <Button size="sm" title="Open GitHub" onPress={() => void open()} />
            <Button size="sm" title="Cancel" disabled={flow.busy} onPress={() => void flow.cancel()} />
          </View>
          <Text accessibilityLiveRegion="polite" style={[type.body, { color: c.muted }]}>
            {copied ? "Code copied. " : ""}Waiting for GitHub. Expires at{" "}
            {attempt.expiresAt ? clock.time(timestampDate(attempt.expiresAt)) : "—"}.
          </Text>
        </View>
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
            onPress={() => {
              setCopied(false);
              setError("");
              void flow.start();
            }}
          />
        </View>
      )}
      {error || flow.error ? (
        <View style={{ gap: 8 }}>
          <Notice error>{error || flow.error}</Notice>
          <Button
            size="sm"
            title="Retry"
            onPress={() => {
              setError("");

              if (attempt?.state === "pending") flow.retry();
              else void flow.start();
            }}
          />
        </View>
      ) : null}
    </View>
  );
}
