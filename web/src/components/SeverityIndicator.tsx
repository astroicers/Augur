import { useBroadcastStore, EMOTION_COLOR } from "../store/broadcastStore";

export function SeverityIndicator() {
  const connected = useBroadcastStore((s) => s.connected);
  const emotion = useBroadcastStore((s) => s.emotion);
  const severity = useBroadcastStore((s) => s.lastSeverity);
  const color = EMOTION_COLOR[emotion];
  return (
    <div className="flex items-center gap-3 text-sm text-slate-200">
      <span
        className={`inline-block h-3 w-3 rounded-full ${connected ? "bg-sev-resolved" : "bg-sev-critical"}`}
      />
      <span>{connected ? "已連線" : "連線中…"}</span>
      <span className="opacity-40">|</span>
      <span>
        嚴重度 <b className={`text-sev-${color}`}>{severity}</b>
      </span>
    </div>
  );
}
