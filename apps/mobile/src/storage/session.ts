import * as SecureStore from "expo-secure-store";
import type { MobileConnection } from "../api/routes";
import { isGatewayAddress } from "../api/client";

export interface DeviceSession extends MobileConnection {
  gatewayUrl: string;
  deviceId: string;
  deviceName: string;
  token: string;
}

const key = "canopy.device.v1";

function isDeviceSession(value: unknown): value is DeviceSession {
  return (
    !!value &&
    typeof value === "object" &&
    "gatewayUrl" in value &&
    typeof value.gatewayUrl === "string" &&
    "deviceId" in value &&
    typeof value.deviceId === "string" &&
    "deviceName" in value &&
    typeof value.deviceName === "string" &&
    "token" in value &&
    typeof value.token === "string" &&
    "fingerprint" in value &&
    typeof value.fingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(value.fingerprint) &&
    "addresses" in value &&
    Array.isArray(value.addresses) &&
    value.addresses.length > 0 &&
    value.addresses.length <= 32 &&
    value.addresses.every(isGatewayAddress)
  );
}

export async function loadSession(): Promise<DeviceSession | null> {
  const raw = await SecureStore.getItemAsync(key);

  if (!raw) return null;
  const value: unknown = JSON.parse(raw);

  if (!isDeviceSession(value))
    throw new Error(
      "This pairing needs a computer certificate. Open Settings → Devices on your computer and pair this phone again.",
    );

  return value;
}

export const saveSession = (value: DeviceSession) =>
  SecureStore.setItemAsync(key, JSON.stringify(value), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });

export const deleteSession = () => SecureStore.deleteItemAsync(key);

/** Serialize route saves and unpairing so an old save cannot restore a forgotten token. */
export class SessionPersistence {
  #current: DeviceSession | null = null;
  #writing: Promise<void> = Promise.resolve();

  async load() {
    this.#current = await loadSession();

    return this.#current;
  }

  save(value: DeviceSession) {
    return this.#serial(async () => {
      await saveSession(value);
      this.#current = value;
    });
  }

  update(deviceId: string, connection: MobileConnection) {
    return this.#serial(async () => {
      const current = this.#current;

      if (!current || current.deviceId !== deviceId) return;

      const next = {
        ...current,
        ...connection,
        lastAddress: connection.lastAddress,
        gatewayUrl: connection.lastAddress ?? connection.addresses[0] ?? current.gatewayUrl,
      };

      await saveSession(next);
      this.#current = next;
    });
  }

  forget() {
    this.#current = null;

    return this.#serial(async () => {
      await deleteSession();
      this.#current = null;
    });
  }

  #serial(run: () => Promise<void>) {
    const next = this.#writing.then(run, run);
    this.#writing = next.catch(() => {});

    return next;
  }
}
