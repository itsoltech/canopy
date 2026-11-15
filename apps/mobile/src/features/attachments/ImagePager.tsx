import { useState } from "react";
import { ActivityIndicator, Image, StyleSheet, Text, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { Button } from "../../ui/Button";
import { styles, useColors } from "../../ui/theme";
import { useImagePagerGestures } from "./image-pager-gestures";
import type { ImagePagerModel } from "./image-pager-model";
import { clamp, MAX_SCALE, type Size } from "./image-zoom";
import type { ImageSource } from "./image-source";
import { useImage } from "./useImage";

export type ViewerImage = { key: string; source: ImageSource; name: string; alt?: string; caption?: string };

/** The current image and its neighbours on a strip that follows the finger. Only three pages stay mounted. */
export function ImagePager({
  model,
  images,
  index,
  onClose,
}: {
  model: ImagePagerModel;
  images: readonly ViewerImage[];
  index: number;
  onClose: () => void;
}) {
  const gesture = useImagePagerGestures(model, onClose);
  const [width, setWidth] = useState(0);
  const current = images[index];

  const strip = useAnimatedStyle(() => ({
    transform: [{ translateX: model.drag.get() - model.page.get() * model.viewport.get().width }],
  }));

  const zoom = (next: number, area?: Size) => {
    const scale = Math.max(1, Math.min(MAX_SCALE, next));
    const limit = model.limits(scale, area);
    model.scale.set(scale);
    model.x.set(clamp(model.x.get(), limit.x));
    model.y.set(clamp(model.y.get(), limit.y));
  };

  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={current ? current.alt || current.name : undefined}
        accessibilityHint={`Adjust to zoom.${images.length > 1 ? " Swipe sideways for other images." : ""} Swipe down to close.`}
        accessibilityActions={[
          { name: "increment", label: "Zoom in" },
          { name: "decrement", label: "Zoom out" },
          { name: "reset", label: "Reset zoom" },
        ]}
        onAccessibilityAction={({ nativeEvent }) => {
          model.claim();

          if (nativeEvent.actionName === "reset") model.resetZoom();
          else zoom(model.scale.get() + (nativeEvent.actionName === "increment" ? 1 : -1));
        }}
        style={{ flex: 1, overflow: "hidden" }}
        onLayout={({ nativeEvent: { layout } }) => {
          const area = { width: layout.width, height: layout.height };
          model.viewport.set(area);
          model.page.set(model.active.get());
          zoom(model.scale.get(), area);
          setWidth(layout.width);
        }}
      >
        {width ? (
          <Animated.View style={[StyleSheet.absoluteFill, strip]}>
            {[index - 1, index, index + 1].map((page) => {
              const image = images[page];

              return image ? <ImagePage key={image.key} image={image} page={page} width={width} model={model} /> : null;
            })}
          </Animated.View>
        ) : null}
      </View>
    </GestureDetector>
  );
}

function ImagePage({
  image,
  page,
  width,
  model,
}: {
  image: ViewerImage;
  page: number;
  width: number;
  model: ImagePagerModel;
}) {
  const c = useColors();
  const loaded = useImage(image.source);
  const [decodeError, setDecodeError] = useState(false);

  const transform = useAnimatedStyle(() => {
    const zoomed = model.zoomed.get() === page;
    const active = model.active.get() === page;
    const dx = active ? model.dismissX.get() : 0;
    const dy = active ? model.dismissY.get() : 0;
    // A dragged-away image shrinks a little as it leaves.
    const shrink = 1 - 0.3 * Math.min(1, Math.abs(dy) / (model.viewport.get().height || 1));

    return {
      transform: [
        { translateX: (zoomed ? model.x.get() : 0) + dx },
        { translateY: (zoomed ? model.y.get() : 0) + dy },
        { scale: (zoomed ? model.scale.get() : 1) * shrink },
      ],
    };
  });

  return (
    <View style={{ position: "absolute", top: 0, bottom: 0, left: page * width, width }}>
      {loaded.uri && !decodeError ? (
        <Animated.View style={[{ flex: 1 }, transform]}>
          <Image
            source={{ uri: loaded.uri }}
            onError={() => setDecodeError(true)}
            onLoad={({ nativeEvent: { source } }) => {
              model.sizes.set({ ...model.sizes.get(), [page]: { width: source.width, height: source.height } });
            }}
            accessibilityIgnoresInvertColors
            resizeMode="contain"
            style={{ width: "100%", height: "100%" }}
          />
        </Animated.View>
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 20, gap: 12 }}>
          {loaded.error || decodeError ? (
            <>
              <Text accessibilityRole="alert" style={[styles.body, { color: c.muted, textAlign: "center" }]}>
                {decodeError
                  ? "Could not display the image. Retry, or export it to open in another app."
                  : loaded.error}
              </Text>
              <Button
                title="Retry"
                onPress={() => {
                  setDecodeError(false);
                  loaded.retry();
                }}
              />
            </>
          ) : (
            <ActivityIndicator accessibilityLabel="Loading image" color={c.muted} />
          )}
        </View>
      )}
    </View>
  );
}
