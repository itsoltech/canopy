export interface DesktopPointerStyle {
  accent: string;
  fill: string;
  rim: string;
  size: number;
  travelMinMs: number;
  travelMaxMs: number;
  ripple: boolean;
}

export interface DesktopPointerAction {
  windowId: string;
  pid: number;
  processInstance: string;
  width: number;
  height: number;
  x: number;
  y: number;
  from?: { x: number; y: number };
  click: boolean;
  style: DesktopPointerStyle;
}
