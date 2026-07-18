import { create } from "zustand";
import type { Emotion } from "../avatar/AvatarController";

/** 導播推來的一則播報計畫（對應後端 BroadcastPlan）。 */
export interface Plan {
  text: string;
  severity: string;
  emotion: Emotion;
  name?: string;
  instance?: string;
  status?: string;
}

interface BroadcastState {
  connected: boolean;
  emotion: Emotion;
  lastSeverity: string;
  feed: Plan[];
  setConnected: (c: boolean) => void;
  pushBroadcast: (p: Plan) => void;
}

export const useBroadcastStore = create<BroadcastState>((set) => ({
  connected: false,
  emotion: "calm",
  lastSeverity: "—",
  feed: [],
  setConnected: (connected) => set({ connected }),
  pushBroadcast: (p) =>
    set((s) => ({ emotion: p.emotion, lastSeverity: p.severity, feed: [p, ...s.feed].slice(0, 20) })),
}));

/** §6 emotion → Tailwind 色票 key（見 tailwind.config sev.*）。 */
export const EMOTION_COLOR: Record<Emotion, string> = {
  calm: "info",
  warning: "warning",
  critical: "critical",
  resolved: "resolved",
};
