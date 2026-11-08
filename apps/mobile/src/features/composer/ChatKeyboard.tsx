import { createContext, useContext, useId, type ReactNode } from "react";
import { KeyboardGestureArea } from "react-native-keyboard-controller";

const InputID = createContext<string | undefined>(undefined);

export function useChatInputID() {
  return useContext(InputID);
}

/** The native gesture region joins the feed to its input, including the space occupied by the composer. */
export function ChatKeyboard({ children, composerHeight }: { children: ReactNode; composerHeight: number }) {
  const id = useId();

  return (
    <InputID.Provider value={id}>
      <KeyboardGestureArea style={{ flex: 1 }} interpolator="ios" textInputNativeID={id} offset={composerHeight}>
        {children}
      </KeyboardGestureArea>
    </InputID.Provider>
  );
}
