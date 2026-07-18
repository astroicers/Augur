import { useBroadcastStore, EMOTION_COLOR } from "../store/broadcastStore";

export function BroadcastFeed() {
  const feed = useBroadcastStore((s) => s.feed);
  return (
    <div className="flex max-h-[40vh] w-[360px] flex-col gap-2 overflow-y-auto">
      {feed.length === 0 && <div className="text-xs text-slate-500">等待告警…</div>}
      {feed.map((p, i) => (
        <div
          key={i}
          className={`rounded border-l-4 bg-slate-900/80 px-3 py-2 text-xs leading-relaxed text-slate-200 border-sev-${EMOTION_COLOR[p.emotion]}`}
        >
          <b className={`text-sev-${EMOTION_COLOR[p.emotion]}`}>[{p.severity}]</b> {p.text}
        </div>
      ))}
    </div>
  );
}
