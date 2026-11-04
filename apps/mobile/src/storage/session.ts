import * as SecureStore from "expo-secure-store";

export interface DeviceSession {
  gatewayUrl: string;
  deviceId: string;
  deviceName: string;
  token: string;
}

const key = "canopy.device.v1";

export async function loadSession(): Promise<DeviceSession | null> {
  const raw = await SecureStore.getItemAsync(key);

  if (!raw) return null;
  const value: unknown = JSON.parse(raw);

  if (
    !value ||
    typeof value !== "object" ||
    !("gatewayUrl" in value) ||
    typeof value.gatewayUrl !== "string" ||
    !("deviceId" in value) ||
    typeof value.deviceId !== "string" ||
    !("deviceName" in value) ||
    typeof value.deviceName !== "string" ||
    !("token" in value) ||
    typeof value.token !== "string"
  )
    throw new Error("Saved pairing is invalid. Pair this phone again.");

  return value as DeviceSession;
}

export const saveSession = (value: DeviceSession) =>
  SecureStore.setItemAsync(key, JSON.stringify(value), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });

export const deleteSession = () => SecureStore.deleteItemAsync(key);
