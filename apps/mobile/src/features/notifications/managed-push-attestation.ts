import { requireOptionalNativeModule } from "expo";
import { CryptoDigestAlgorithm, CryptoEncoding, digestStringAsync } from "expo-crypto";
import { Platform } from "react-native";

const native = requireOptionalNativeModule<{ isSupported?: boolean }>("ExpoAppIntegrity");

const serverUnavailable = "ERR_APP_INTEGRITY_SERVER_UNAVAILABLE";

const unsupported = [
  "ERR_APP_INTEGRITY_FEATURE_UNSUPPORTED",
  "ERR_APP_INTEGRITY_PLAY_SERVICES_NOT_FOUND",
  "ERR_APP_INTEGRITY_PLAY_STORE_NOT_FOUND",
];

export const managedPushSupport = !native
  ? "buildUnavailable"
  : Platform.OS === "android" || (Platform.OS === "ios" && native.isSupported)
    ? "supported"
    : "deviceUnavailable";

export class ManagedPushDeviceUnavailable extends Error {}

export class ManagedPushAttestation {
  #pendingAppleKey: string | undefined;

  clear() {
    this.#pendingAppleKey = undefined;
  }

  async prove(
    { challenge, androidCloudProjectNumber }: { challenge: string; androidCloudProjectNumber: string },
    expoToken: string,
    current: () => boolean,
  ) {
    if (!challenge) throw new Error("Missing push enrollment challenge");

    const digest = await digestStringAsync(
      CryptoDigestAlgorithm.SHA256,
      `canopy-push-enrollment-v1\n${Platform.OS}\n${expoToken}\n${challenge}`,
      { encoding: CryptoEncoding.BASE64 },
    );

    const input = digest.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    const integrity = await import("@expo/app-integrity");

    if (!current()) return;

    try {
      if (Platform.OS === "ios") {
        const keyId = this.#pendingAppleKey ?? (await integrity.generateKeyAsync());

        if (!current()) return;
        this.#pendingAppleKey = keyId;
        const attestation = await integrity.attestKeyAsync(keyId, input);
        this.clear();

        return { keyId, attestation };
      }

      await integrity.prepareIntegrityTokenProviderAsync(androidCloudProjectNumber);

      if (!current()) return;

      return { attestation: await integrity.requestIntegrityCheckAsync(input) };
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined;

      // Apple permits retrying a pending key when its attestation service is unavailable.
      if (code !== serverUnavailable) this.clear();

      if (unsupported.some((unsupportedCode) => code === unsupportedCode)) throw new ManagedPushDeviceUnavailable();
      throw error;
    }
  }
}
