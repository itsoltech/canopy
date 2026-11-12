import type { ui } from "@canopy/contracts";

export function appendRecord(snapshot: ui.ThreadSnapshot, record: ui.ThreadSyncRecord) {
  const value = record.value;

  switch (value.case) {
    case "thread":
      snapshot.thread = value.value;
      break;
    case "turn":
      snapshot.turns.push(value.value);
      break;
    case "item":
      snapshot.items.push(value.value);
      break;
    case "notice":
      snapshot.notices.push(value.value);
      break;
    case "interaction":
      snapshot.interactions.push(value.value);
      break;
    case "goal":
      snapshot.goal = value.value;
      break;
    case "steer":
      snapshot.steers.push(value.value);
      break;
    case "busDelivery":
      snapshot.busDeliveries.push(value.value);
      break;
  }
}
