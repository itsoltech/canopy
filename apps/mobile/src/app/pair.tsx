import { useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Redirect, router } from "expo-router";
import { CameraView, useCameraPermissions } from "expo-camera";
import { fetch } from "expo/fetch";
import * as Device from "expo-device";
import { SafeAreaView } from "react-native-safe-area-context";
import { mobileClient, readPairingQr } from "../api/client";
import { useSession } from "../state/session";
import { Button, Field, Notice } from "../ui/components";
import { styles, useColors } from "../ui/theme";

export default function Pair() {
  const c = useColors();
  const { session, ready, pair, error: sessionError } = useSession();
  const [gatewayUrl, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState(
    Device.deviceName ?? (Platform.OS === "ios" ? "My iPhone" : "My Android"),
  );
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const scanLock = useRef(false);
  const submitting = useRef(false);
  if (!ready)
    return <ActivityIndicator accessibilityLabel="Opening secure storage" />;
  if (session) return <Redirect href="/" />;
  async function scan() {
    setError("");
    const granted = permission?.granted || (await requestPermission()).granted;
    if (!granted) {
      setError(
        "Camera permission is needed to scan a QR code. You can enter the code below instead.",
      );
      return;
    }
    scanLock.current = false;
    setScanning(true);
  }
  function scanned(data: string) {
    if (scanLock.current) return;
    scanLock.current = true;
    setScanning(false);
    try {
      const qr = readPairingQr(data);
      setUrl(qr.gatewayUrl);
      setCode(qr.code);
      setError("");
    } catch {
      setError(
        "Scan the pairing QR code from Canopy → Settings → Mobile devices.",
      );
    }
  }
  async function connect() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const client = mobileClient({
        gatewayUrl,
        fetch: fetch as typeof globalThis.fetch,
        development: __DEV__,
      });
      const response = await client.pairing.exchangeMobilePairing(
        { code, name, platform: Platform.OS },
        { timeoutMs: 15_000 },
      );
      if (!response.device || !response.deviceToken)
        throw new Error("Invalid pairing response");
      // Persist before navigation. A storage failure must not leave the UI pretending it is paired.
      try {
        await pair({
          gatewayUrl: gatewayUrl.trim().replace(/\/$/, ""),
          deviceId: response.device.id,
          deviceName: response.device.name,
          token: response.deviceToken,
        });
      } catch {
        // Exchange is single-use. Revoke the credential if secure storage failed.
        await mobileClient({
          gatewayUrl,
          token: response.deviceToken,
          fetch: fetch as typeof globalThis.fetch,
          development: __DEV__,
        })
          .api.unpairMobileDevice({}, { timeoutMs: 5000 })
          .catch(() => undefined);
        throw new Error(
          "Could not save the token securely. Create a new pairing code and try again.",
        );
      }
      setCode("");
      router.replace("/");
    } catch (e) {
      setError(
        e instanceof TypeError
          ? "Cannot reach this gateway. Check Tailscale and the HTTPS address."
          : e instanceof Error
            ? e.message
            : "Pairing failed. Create a new code in web Settings.",
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <SafeAreaView style={styles.fill}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.fill}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={
            Platform.OS === "ios" ? "interactive" : "on-drag"
          }
          contentContainerStyle={styles.page}
        >
          <Image
            source={require("../../../web/static/icon-512.png")}
            accessibilityLabel="Canopy"
            style={{ width: 72, height: 72, borderRadius: 18, marginTop: 16 }}
          />
          <View style={{ gap: 10 }}>
            <Text style={[styles.title, { color: c.text }]}>Canopy</Text>
            <Text style={[styles.body, { color: c.muted }]}>
              Connect to your gateway
            </Text>
          </View>
          <View style={{ gap: 12 }}>
            <Text style={[styles.heading, { color: c.text }]}>
              Pair with your Canopy
            </Text>
            <Text style={[styles.body, { color: c.muted }]}>
              On the web, open Settings → Mobile devices → Pair a phone. Connect
              this phone to Tailscale first.
            </Text>
          </View>
          {(error || sessionError) && (
            <Notice error>{error || sessionError}</Notice>
          )}
          {scanning ? (
            <View style={{ gap: 12 }}>
              <CameraView
                style={{ height: 280, borderRadius: 16, overflow: "hidden" }}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
                onBarcodeScanned={({ data }) => scanned(data)}
                onMountError={() => {
                  setScanning(false);
                  setError("Camera unavailable. Enter the pairing code below.");
                }}
              />
              <Button
                title="Cancel scan"
                secondary
                onPress={() => setScanning(false)}
              />
            </View>
          ) : (
            <Button
              title="Scan pairing QR code"
              onPress={() => void scan()}
              disabled={busy}
            />
          )}
          <Text style={[styles.body, { color: c.muted, textAlign: "center" }]}>
            or enter the details
          </Text>
          <Field
            label="Gateway HTTPS address"
            value={gatewayUrl}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://canopy.your-tailnet.ts.net:8443"
            editable={!busy}
          />
          <Field
            label="Pairing code"
            value={code}
            onChangeText={setCode}
            autoCapitalize="characters"
            autoCorrect={false}
            placeholder="ABCD-EF23-4567-89AB"
            maxLength={24}
            editable={!busy}
          />
          <Field
            label="Device name"
            value={name}
            onChangeText={setName}
            maxLength={100}
            editable={!busy}
          />
          <Button
            title="Pair this phone"
            secondary
            onPress={() => void connect()}
            disabled={!gatewayUrl.trim() || !code.trim() || !name.trim()}
            busy={busy}
          />
          <Text style={[styles.meta, { color: c.muted }]}>
            Your device key stays in encrypted storage. You can revoke access at
            any time in web Settings.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
