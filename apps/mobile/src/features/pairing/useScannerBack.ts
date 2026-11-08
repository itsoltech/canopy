import { useCallback } from "react";
import { BackHandler } from "react-native";
import { useFocusEffect } from "expo-router";

/** The camera is a step within pairing, so Android back returns to the filled form first. */
export function useScannerBack(scanning: boolean, setScanning: (scanning: boolean) => void) {
  useFocusEffect(
    useCallback(() => {
      if (!scanning) return;

      const listener = BackHandler.addEventListener("hardwareBackPress", () => {
        setScanning(false);

        return true;
      });

      return () => listener.remove();
    }, [scanning, setScanning]),
  );
}
