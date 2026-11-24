import * as SecureStore from "expo-secure-store";
import { usagePingBody, usagePingEndpoint, usagePingRetryMs, usagePingTimeoutMs } from "@canopy/domain/usage-ping";
import { Dimensions, Platform } from "react-native";
import { supportedCpuArchitectures } from "expo-device";
import { fetch } from "expo/fetch";
import { CANOPY_VERSION } from "../version";

const preferenceKey = "canopy.usage-ping.enabled";
const dateKey = "canopy.usage-ping.last-date";
const storageOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
let sending = false;
let retryAfter = 0;

export async function readUsagePingEnabled() {
  const value = await SecureStore.getItemAsync(preferenceKey);

  if (value === "on") return true;

  if (value === null || value === "off") return false;
  throw new Error("Invalid usage ping preference");
}

export function saveUsagePingEnabled(enabled: boolean) {
  return SecureStore.setItemAsync(preferenceKey, enabled ? "on" : "off", storageOptions);
}

export async function sendUsagePingIfDue(allowed: () => boolean) {
  if (__DEV__ || !allowed() || sending || Date.now() < retryAfter) return;
  sending = true;

  try {
    const today = new Date().toISOString().slice(0, 10);
    const last = await SecureStore.getItemAsync(dateKey);

    if (last === today || !allowed()) return;

    // Reserve the UTC day before dispatch. Preference writes use a separate key.
    await SecureStore.setItemAsync(dateKey, today, storageOptions);

    if (!allowed()) {
      await SecureStore.deleteItemAsync(dateKey);

      return;
    }

    if (!(await deliverPing())) {
      retryAfter = Date.now() + usagePingRetryMs;
      await SecureStore.deleteItemAsync(dateKey);
    }
  } catch {
    retryAfter = Date.now() + usagePingRetryMs;
  } finally {
    sending = false;
  }
}

function cpuArchitecture() {
  const abi = supportedCpuArchitectures?.[0]?.toLowerCase() ?? "";

  if (abi.startsWith("arm64")) return "arm64";

  if (abi.startsWith("arm")) return "arm";

  if (abi === "x86_64") return "x64";

  if (abi === "x86" || abi === "i386") return "ia32";
}

async function deliverPing() {
  try {
    const { width, height } = Dimensions.get("screen");
    const arch = cpuArchitecture();

    const response = await fetch(usagePingEndpoint, {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(usagePingTimeoutMs),
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Canopy Mobile",
      },
      body: usagePingBody({
        version: CANOPY_VERSION,
        os: Platform.OS,
        ...(arch && { arch }),
        language: Intl.DateTimeFormat().resolvedOptions().locale,
        screen: `${Math.round(width)}x${Math.round(height)}`,
      }),
    });

    void response.body?.cancel().catch(() => {});

    return response.ok;
  } catch {
    return false;
  }
}
