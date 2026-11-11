import { useState, type ComponentProps } from "react";
import { Field } from "./components";

/** Multiline kit field that grows with its content before scrolling. */
export function AutoGrowingField(props: ComponentProps<typeof Field>) {
  const [height, setHeight] = useState(112);

  return (
    <Field
      {...props}
      multiline
      scrollEnabled={height > 320}
      onContentSizeChange={(event) => setHeight(Math.ceil(event.nativeEvent.contentSize.height))}
      style={[props.style, { minHeight: 112, height: Math.min(320, Math.max(112, height)), textAlignVertical: "top" }]}
    />
  );
}
