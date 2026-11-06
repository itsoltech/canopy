import { createContext, useContext, type ReactNode } from "react";
import { Text, type StyleProp, type TextProps, type TextStyle } from "react-native";
import { font, useTypography } from "../theme";

/** The face of a run of text: nested emphasis adds to its parent's (bold inside a heading, italic inside bold). */
interface Face {
  readonly weight: "regular" | "medium" | "semibold";
  readonly italic: boolean;
}

const Current = createContext<Face>({ weight: "regular", italic: false });

/** Inter has a family per weight and slant; iOS does not slant or embolden a custom family by style alone. */
const INTER = {
  regular: [font.regular, font.regularItalic],
  medium: [font.medium, font.mediumItalic],
  semibold: [font.semibold, font.semiboldItalic],
} as const;

const WEIGHT = { regular: "400", medium: "500", semibold: "600" } as const;

/** The style of a face in the reader's interface font: Inter by family, the system and serif fonts by weight and style. */
function useFaceStyle(face: Face): TextStyle {
  const family = useTypography().body.fontFamily;

  return family === font.regular
    ? { fontFamily: INTER[face.weight][face.italic ? 1 : 0] }
    : { fontWeight: WEIGHT[face.weight], fontStyle: face.italic ? "italic" : "normal" };
}

/** A `Text` that sets a weight or slant over its parent's face, for itself and the text nested in it. */
export function Faced({
  weight,
  italic,
  style,
  children,
  ...props
}: Omit<TextProps, "style"> & {
  weight?: Face["weight"];
  italic?: boolean;
  style?: StyleProp<TextStyle>;
  children: ReactNode;
}) {
  const parent = useContext(Current);
  const face = { weight: weight ?? parent.weight, italic: italic ?? parent.italic };
  const faceStyle = useFaceStyle(face);

  return (
    <Current.Provider value={face}>
      <Text {...props} style={[style, faceStyle]}>
        {children}
      </Text>
    </Current.Provider>
  );
}
