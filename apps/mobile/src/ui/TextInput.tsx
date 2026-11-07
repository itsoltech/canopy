import type { ComponentPropsWithRef } from "react";
import { Platform, TextInput as NativeTextInput } from "react-native";

// UIKit applies an explicit lineHeight as a paragraph height to both text and placeholders. Unlike Text,
// its default typing attributes do not get React Native's baseline correction. Use the font's native metrics.
export const inputTypography = Platform.OS === "ios" ? { lineHeight: undefined } : undefined;

/** All editable fields share native iOS line metrics; Android keeps the caller's styles. */
export function TextInput({ style, ...props }: ComponentPropsWithRef<typeof NativeTextInput>) {
  return <NativeTextInput {...props} style={inputTypography ? [style, inputTypography] : style} />;
}
