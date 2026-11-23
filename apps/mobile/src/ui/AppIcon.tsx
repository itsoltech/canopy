import { str } from "@canopy/domain/json";
import { appIdentity, type AppChannel } from "@canopy/domain/release/identity";
import { releaseChannel } from "@canopy/domain/release/version";
import Constants from "expo-constants";
import { channel as updatesChannel } from "expo-updates";
import { Image, type ImageSourcePropType, type ImageStyle, type StyleProp } from "react-native";
import { CANOPY_VERSION } from "../version";

// Metro needs literal requires to bundle the tiles for offline use.
const icons: Record<AppChannel, ImageSourcePropType> = {
  stable: require("../../../web/static/channels/stable/icon-256.png"),
  beta: require("../../../web/static/channels/beta/icon-256.png"),
  nightly: require("../../../web/static/channels/nightly/icon-256.png"),
  development: require("../../../web/static/channels/development/icon-256.png"),
};

const configuredChannel = str(Constants.expoConfig?.extra?.["canopyChannel"]);
const channel = [configuredChannel, updatesChannel ?? ""].find((value) => Object.hasOwn(icons, value));
export const mobileApp = appIdentity(channel ?? releaseChannel(CANOPY_VERSION));

export function AppIcon({ size, style }: { size: number; style?: StyleProp<ImageStyle> }) {
  return <Image accessible={false} source={icons[mobileApp.channel]} style={[{ width: size, height: size }, style]} />;
}
