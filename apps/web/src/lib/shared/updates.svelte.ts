import { UpdateNotice } from "./updates.ts";

export const updateState = $state({ available: false });
export const updateNotice = new UpdateNotice(() => (updateState.available = true));
