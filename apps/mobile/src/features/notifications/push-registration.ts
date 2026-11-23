import { Code, ConnectError } from "@connectrpc/connect";
import { AppState } from "react-native";
import type { DevicePushToken } from "expo-notifications";
import type { mobileClient } from "../../api/client";
import type { MobilePushPreference } from "../../storage/session";
import { ManagedPushAttestation, ManagedPushDeviceUnavailable, managedPushSupport } from "./managed-push-attestation";
import {
  expoTokenEndpoint,
  getPreviewKey,
  loadNotifications,
  pushBuildConfigured,
  pushPermission,
  pushProjectId,
  withdrawMobilePushLocally,
  type NativeNotifications,
} from "./native-push";

type Phase =
  | "checking"
  | "idle"
  | "buildUnavailable"
  | "managedBuildUnavailable"
  | "managedDeviceUnavailable"
  | "desktopRelayUnavailable"
  | "gatewayUnavailable"
  | "enabling"
  | "verifying"
  | "enabled"
  | "disabling"
  | "permission"
  | "settings"
  | "retryChecking"
  | "retryEnabling"
  | "retryVerifying"
  | "retryDisabling"
  | "saveFailed";

interface Snapshot {
  requested: boolean;
  canEnable: boolean;
  saving: boolean;
  phase: Phase;
}

const requestTimeout = 12_000;

const transientSubscriptionErrors = [
  Code.Aborted,
  Code.Canceled,
  Code.DeadlineExceeded,
  Code.ResourceExhausted,
  Code.Unavailable,
  Code.Unknown,
];

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Notification registration timed out")), requestTimeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class PushRegistration {
  #snapshot: Snapshot;
  #listeners = new Set<() => void>();
  #preference: MobilePushPreference | undefined;
  #revision = 0;
  #prompt = false;
  #pending = false;
  #running = false;
  #readingNativeToken = false;
  #deviceToken: DevicePushToken | undefined;
  #localWithdrawal: Promise<boolean> | undefined;
  #attestation = new ManagedPushAttestation();

  constructor(
    private readonly api: ReturnType<typeof mobileClient>["api"],
    private readonly deviceId: string,
    private readonly lifetime: AbortSignal,
    saved: MobilePushPreference | undefined,
    private readonly save: (value: MobilePushPreference | undefined) => Promise<void>,
  ) {
    this.#preference = saved;
    this.#snapshot = { requested: saved === "on", canEnable: false, saving: false, phase: "checking" };
  }

  snapshot = () => this.#snapshot;

  subscribe = (update: () => void) => {
    this.#listeners.add(update);

    return () => this.#listeners.delete(update);
  };

  #publish(change: Partial<Snapshot>) {
    if (this.lifetime.aborted) return;
    this.#snapshot = { ...this.#snapshot, ...change };

    for (const update of this.#listeners) update();
  }

  setEnabled = async (enabled: boolean) => {
    if (this.lifetime.aborted || this.#snapshot.saving || (enabled && !this.#snapshot.canEnable)) return;

    this.#revision++;
    this.#prompt = false;
    this.#publish({ saving: true });
    const next = enabled ? "on" : "off";

    try {
      await this.save(next);
      this.#preference = next;
      this.#prompt = enabled;

      if (!enabled && !this.lifetime.aborted) void this.#withdrawLocally();
      this.#publish({ requested: enabled, saving: false, phase: enabled ? "enabling" : "disabling" });
      this.refresh();
    } catch {
      this.#publish({ saving: false, phase: "saveFailed" });
    }
  };

  retry = () => {
    if (this.#snapshot.phase === "permission") this.#prompt = true;
    this.refresh();
  };

  refresh = () => {
    if (this.lifetime.aborted || this.#snapshot.saving) return;
    this.#pending = true;

    if (!this.#running) void this.#drain();
  };

  tokenChanged = (token: DevicePushToken) => {
    if (this.#preference !== "on" || this.#deviceToken?.data === token.data) return;
    this.#deviceToken = token;

    if (!this.#readingNativeToken) this.refresh();
  };

  async #drain() {
    this.#running = true;

    while (this.#pending && !this.lifetime.aborted && !this.#snapshot.saving) {
      this.#pending = false;
      const revision = this.#revision;
      const current = () => !this.lifetime.aborted && revision === this.#revision;

      try {
        await this.#reconcile(current);
      } catch (error) {
        if (current()) {
          const code = ConnectError.from(error).code;

          if (code === Code.Unimplemented) this.#publish({ phase: "gatewayUnavailable", canEnable: false });
          else if (error instanceof ManagedPushDeviceUnavailable)
            this.#publish({ phase: "managedDeviceUnavailable", canEnable: false });
          else this.#publish({ phase: this.#retryPhase() });
        }
      }
    }

    this.#running = false;
  }

  async #reconcile(current: () => boolean) {
    if (this.#preference === "off") {
      await this.#disable();

      if (!current()) return;
      await this.save(undefined);

      if (!current()) return;
      this.#preference = undefined;
    }

    const native = await loadNotifications();

    if (!current()) return;

    if (!native || !pushBuildConfigured) {
      this.#publish({ phase: "buildUnavailable", canEnable: false });

      return;
    }

    const caps = await this.api.getClientCapabilities({}, this.#options);

    if (!current()) return;
    const managed = caps.managedMobilePush && !caps.mobilePush;
    const canEnable = caps.mobilePush || (managed && managedPushSupport === "supported");
    this.#publish({ canEnable });

    if (managed && !canEnable) {
      this.#publish({
        phase: managedPushSupport === "buildUnavailable" ? "managedBuildUnavailable" : "managedDeviceUnavailable",
      });

      return;
    }

    if (!canEnable) {
      this.#publish({ phase: caps.gatewayRole === "desktop" ? "desktopRelayUnavailable" : "gatewayUnavailable" });

      return;
    }

    if (this.#preference !== "on") {
      this.#publish({ phase: "idle" });

      return;
    }

    const permission = await pushPermission(native, () => {
      if (!current() || !this.#prompt || AppState.currentState !== "active") return false;
      this.#prompt = false;

      return true;
    });

    if (!current()) return;

    if (permission !== "granted") {
      this.#publish({ phase: permission });
      // A revoked OS permission stops display immediately. Retry withdrawing the gateway subscription on resume.
      await this.#disable().catch(() => {});

      return;
    }

    this.#prompt = false;
    this.#localWithdrawal = undefined;

    if (this.#snapshot.phase !== "enabled") this.#publish({ phase: "enabling" });
    await this.#register(native, managed, current);
  }

  async #readNativeToken(native: NativeNotifications) {
    this.#readingNativeToken = true;

    try {
      const token = await withTimeout(native.getDevicePushTokenAsync());
      this.#deviceToken = token;

      return token;
    } finally {
      this.#readingNativeToken = false;
    }
  }

  async #register(native: NativeNotifications, managed: boolean, current: () => boolean) {
    const devicePushToken = await this.#readNativeToken(native);

    if (!current()) return;

    const { data: expoToken } = await withTimeout(
      native.getExpoPushTokenAsync({ projectId: pushProjectId, devicePushToken, url: expoTokenEndpoint }),
    );

    const tokenCurrent = () => current() && this.#deviceToken?.data === devicePushToken.data;

    if (!tokenCurrent()) return;
    const previewKey = await getPreviewKey(this.deviceId, tokenCurrent);

    if (!tokenCurrent()) return;

    if (!previewKey) throw new Error("Notification preview key unavailable");

    const subscribe = () => this.api.setMobilePushSubscription({ enabled: true, expoToken, previewKey }, this.#options);

    const enrollment = managed ? await this.api.beginManagedMobilePush({ expoToken }, this.#options) : undefined;

    if (!tokenCurrent()) return;

    if (!enrollment?.enrollmentId) {
      this.#attestation.clear();
      await subscribe();

      if (tokenCurrent()) this.#publish({ phase: "enabled" });

      return;
    }

    let passive = enrollment.refreshExistingGrant;

    if (passive) {
      try {
        await subscribe();
      } catch (error) {
        if (!tokenCurrent()) return;
        const code = ConnectError.from(error).code;

        if (code !== Code.FailedPrecondition) {
          if (this.#snapshot.phase === "enabled" && transientSubscriptionErrors.includes(code)) return;
          throw error;
        }

        // The old grant expired after Begin. The challenge can still complete enrollment.
        passive = false;
      }
    }

    if (!tokenCurrent()) return;
    this.#publish({ phase: passive ? "enabled" : "verifying" });

    try {
      const proof = await this.#attestation.prove(enrollment, expoToken, tokenCurrent);

      if (!proof || !tokenCurrent()) return;
      await this.api.completeManagedMobilePush(
        { enrollmentId: enrollment.enrollmentId, previewKey, ...proof },
        this.#options,
      );
    } catch (error) {
      if (!passive) throw error;
      // Preserve delivery through the existing grant. The next normal refresh can try again.
    }

    if (!passive && tokenCurrent()) this.#publish({ phase: "enabled" });
  }

  async #disable() {
    this.#deviceToken = undefined;

    // Clear the on-device preview before depending on the network to remove the subscription.
    const [local, remote] = await Promise.allSettled([
      this.#withdrawLocally(),
      this.api.setMobilePushSubscription({ enabled: false }, this.#options).catch((error) => {
        if (ConnectError.from(error).code !== Code.Unimplemented) throw error;
      }),
    ]);

    if (remote.status === "rejected") throw remote.reason;

    if (local.status !== "fulfilled" || !local.value) throw new Error("Could not remove notification preview key");
  }

  #withdrawLocally() {
    this.#attestation.clear();

    return (this.#localWithdrawal ??= withdrawMobilePushLocally().then((cleared) => {
      if (!cleared) this.#localWithdrawal = undefined;

      return cleared;
    }));
  }

  get #options() {
    return { signal: this.lifetime, timeoutMs: requestTimeout };
  }

  #retryPhase() {
    if (this.#snapshot.phase === "verifying") return "retryVerifying";

    if (this.#preference === "on") return "retryEnabling";

    if (this.#preference === "off") return "retryDisabling";

    return "retryChecking";
  }
}
