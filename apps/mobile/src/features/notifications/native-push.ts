import { requireOptionalNativeModule } from "expo";
import Constants from "expo-constants";
import { Platform } from "react-native";
import type { NotificationPermissionsStatus } from "expo-notifications";

export type NativeNotifications = typeof import("expo-notifications");

interface PreviewModule {
  getOrCreateKey(deviceId: string): Promise<string>;
  clearKey(): Promise<void>;
}

const preview = requireOptionalNativeModule<PreviewModule>("CanopyPushPreview");
const hasNotifications = requireOptionalNativeModule("ExpoPushTokenManager") !== null;
const channelId = "canopy-updates";
let loaded: Promise<NativeNotifications | undefined> | undefined;

export function loadNotifications() {
  if (!hasNotifications) return Promise.resolve(undefined);

  return (loaded ??= import("expo-notifications")
    .then((native) => {
      native.setNotificationHandler({
        // The in-app stream owns foreground alerts, including ones with a system preview.
        handleNotification: async () => ({
          shouldShowBanner: false,
          shouldShowList: false,
          shouldPlaySound: false,
          shouldSetBadge: false,
        }),
      });

      return native;
    })
    .catch(() => undefined));
}

export const pushProjectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;

export const pushBuildConfigured =
  Boolean(preview && hasNotifications && pushProjectId) &&
  (Platform.OS !== "android" || Boolean(Constants.expoConfig?.android?.googleServicesFile));

export async function pushPermission(native: NativeNotifications, prompt: () => boolean) {
  if (Platform.OS === "android")
    await native.setNotificationChannelAsync(channelId, {
      name: "Canopy updates",
      importance: native.AndroidImportance.DEFAULT,
      sound: "default",
      lockscreenVisibility: native.AndroidNotificationVisibility.PRIVATE,
      showBadge: true,
    });

  const permission = await native.getPermissionsAsync();
  const granted = pushPermissionGranted(native, permission);
  const canRequest = granted ? Boolean(permission.ios && !permission.ios.allowsBadge) : permission.canAskAgain;

  const current =
    canRequest && prompt()
      ? await native.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: true } })
      : permission;

  if (Platform.OS === "android") {
    const channel = await native.getNotificationChannelAsync(channelId);

    if (channel?.importance === native.AndroidImportance.NONE) return "settings";
  }

  if (pushPermissionGranted(native, current)) return "granted";

  return current.canAskAgain ? "permission" : "settings";
}

function pushPermissionGranted(native: NativeNotifications, permission: NotificationPermissionsStatus) {
  return permission.ios ? permission.ios.status === native.IosAuthorizationStatus.AUTHORIZED : permission.granted;
}

// The implementation installs its own send policy. Supplying Expo's endpoint explicitly disables
// the SDK's persisted auto-registration, which would otherwise refresh outside the current opt-in.
export const expoTokenEndpoint = "https://exp.host/--/api/v2/push/getExpoPushToken";

let keyWork: Promise<unknown> = Promise.resolve();

function withPreviewKey<T>(work: (module: PreviewModule) => Promise<T>) {
  const next = keyWork.then(() => (preview ? work(preview) : undefined));
  keyWork = next.catch(() => {});

  return next;
}

export function getPreviewKey(deviceId: string, current: () => boolean) {
  return withPreviewKey(async (module) => {
    if (!current()) return undefined;
    const key = await module.getOrCreateKey(deviceId);

    // Canonical base64url encoding of 32 bytes, with zero padding bits in the last character.
    return /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(key) ? key : undefined;
  });
}

let badgeWork = Promise.resolve();

export function setIconBadge(count: number, current = () => true) {
  if (Platform.OS !== "ios") return Promise.resolve();

  const next = badgeWork.then(async () => {
    const native = await loadNotifications();

    if (current()) await native?.setBadgeCountAsync(count);
  });

  return (badgeWork = next.catch(() => {}));
}

export async function withdrawMobilePushLocally() {
  try {
    await withPreviewKey((module) => module.clearKey());

    return true;
  } catch {
    return false;
  } finally {
    const native = await loadNotifications();
    await Promise.all([native?.dismissAllNotificationsAsync().catch(() => {}), setIconBadge(0)]);
  }
}
