import type { ReactNode } from "react";
import { useIsFocused } from "expo-router";
import { VisibilityScope } from "./viewport";

/** Native stacks retain covered screens. Their clocks and decorations must follow focus, not mounting. */
export function ScreenActivity({ children }: { children: ReactNode }) {
  return <VisibilityScope visible={useIsFocused()}>{children}</VisibilityScope>;
}
