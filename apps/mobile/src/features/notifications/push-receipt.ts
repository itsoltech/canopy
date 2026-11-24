import { isString } from "@canopy/domain/json";
import type { NotificationRequest } from "expo-notifications";

const receiptPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function pushReceiptId({ content, identifier }: NotificationRequest) {
  // Expo exposes Android's native Canopy notification tag in its presented notification identifier.
  const id =
    content.data?.receiptId ??
    /^expo-notifications:\/\/foreign_notifications\?tag=canopy-push%3a([^&]+)&id=0$/i.exec(identifier)?.[1];

  return isString(id) && receiptPattern.test(id) ? id.toLowerCase() : undefined;
}
