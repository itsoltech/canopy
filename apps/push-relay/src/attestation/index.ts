import { createAppleVerifier } from "./apple.ts";
import { createPlayIntegrityVerifier } from "./google.ts";
import { readServiceAccount } from "./google-auth.ts";

export interface AttestationInput {
  platform: "ios" | "android";
  challenge: string;
  attestation: string;
  keyId?: string;
}

export interface AttestationVerifier {
  cloudProjectNumber?: string;
  supports(platform: AttestationInput["platform"]): boolean;
  verify(input: AttestationInput): Promise<boolean>;
}

type Env = Readonly<Record<string, string | undefined>>;

function appleFromEnv(env: Env) {
  const teamId = env["CANOPY_PUSH_APPLE_TEAM_ID"];
  const bundleId = env["CANOPY_PUSH_APPLE_BUNDLE_ID"];
  const environment = env["CANOPY_PUSH_APPLE_ENVIRONMENT"];

  if (teamId === undefined && bundleId === undefined && environment === undefined) return;

  if (!teamId || !/^[A-Z0-9]{10}$/.test(teamId) || !bundleId || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId))
    throw new Error("Configure CANOPY_PUSH_APPLE_TEAM_ID and CANOPY_PUSH_APPLE_BUNDLE_ID for App Attest.");

  if (environment !== undefined && environment !== "production" && environment !== "development")
    throw new Error("CANOPY_PUSH_APPLE_ENVIRONMENT must be production or development.");

  return createAppleVerifier({ teamId, bundleId, development: environment === "development" });
}

function androidFromEnv(env: Env) {
  const packageName = env["CANOPY_PUSH_ANDROID_PACKAGE_NAME"];
  const cloudProjectNumber = env["CANOPY_PUSH_ANDROID_CLOUD_PROJECT_NUMBER"];
  const serviceAccountFile = env["CANOPY_PUSH_ANDROID_SERVICE_ACCOUNT_FILE"];
  const fingerprints = env["CANOPY_PUSH_ANDROID_SIGNING_CERT_SHA256"];
  const allowUnrecognized = env["CANOPY_PUSH_ANDROID_ALLOW_UNRECOGNIZED_VERSION"];

  if (
    [packageName, cloudProjectNumber, serviceAccountFile, fingerprints, allowUnrecognized].every(
      (value) => value === undefined,
    )
  )
    return;

  if (!packageName || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName))
    throw new Error("CANOPY_PUSH_ANDROID_PACKAGE_NAME must be a valid Android package name.");

  if (
    !cloudProjectNumber ||
    !/^[1-9]\d{0,15}$/.test(cloudProjectNumber) ||
    !Number.isSafeInteger(Number(cloudProjectNumber))
  )
    throw new Error("CANOPY_PUSH_ANDROID_CLOUD_PROJECT_NUMBER must be a positive cloud project number.");

  if (allowUnrecognized !== undefined && allowUnrecognized !== "0" && allowUnrecognized !== "1")
    throw new Error("CANOPY_PUSH_ANDROID_ALLOW_UNRECOGNIZED_VERSION must be 0 or 1.");

  const digests = fingerprints?.split(",").map((digest) => digest.trim().toLowerCase());

  if (!digests || digests.some((digest) => !/^[0-9a-f]{64}$/.test(digest)))
    throw new Error("CANOPY_PUSH_ANDROID_SIGNING_CERT_SHA256 must contain comma-separated SHA-256 hex fingerprints.");

  const serviceAccount = readServiceAccount(serviceAccountFile);
  const signingCerts = new Set(digests);

  return {
    cloudProjectNumber,
    verify: createPlayIntegrityVerifier(
      { packageName, signingCerts, allowUnrecognized: allowUnrecognized === "1" },
      serviceAccount,
    ),
  };
}

export function attestationFromEnv(env: Env): AttestationVerifier | undefined {
  const apple = appleFromEnv(env);
  const android = androidFromEnv(env);

  if (!apple && !android) return;

  return {
    ...(android && { cloudProjectNumber: android.cloudProjectNumber }),
    supports: (platform) => (platform === "ios" ? apple !== undefined : android !== undefined),
    async verify(input) {
      const { challenge, attestation } = input;

      if (
        !/^[A-Za-z0-9_-]{43}$/.test(challenge) ||
        Buffer.from(challenge, "base64url").toString("base64url") !== challenge ||
        !attestation ||
        attestation.length > 16 * 1024
      )
        return false;

      try {
        return input.platform === "ios" ? (apple?.(input) ?? false) : ((await android?.verify(input)) ?? false);
      } catch {
        return false;
      }
    },
  };
}
