import { useCallback, useRef, useState } from "react";
import { AvatarStage, type AvatarStageHandle } from "./avatar/AvatarStage";
import { SeverityIndicator } from "./components/SeverityIndicator";
import { BroadcastFeed } from "./components/BroadcastFeed";
import { GrafanaPanel } from "./components/GrafanaPanel";
import { useBroadcastSocket } from "./hooks/useBroadcastSocket";
import type { Plan } from "./store/broadcastStore";

const TESTS: { severity: string; label: string; cls: string }[] = [
  { severity: "critical", label: "critical", cls: "bg-sev-critical" },
  { severity: "warning", label: "warning", cls: "bg-sev-warning" },
  { severity: "resolved", label: "resolved", cls: "bg-sev-resolved" },
];

export default function App() {
  const stageRef = useRef<AvatarStageHandle>(null);
  const [audioOn, setAudioOn] = useState(false);

  const onBroadcast = useCallback((plan: Plan, audio: string) => {
    stageRef.current?.playBroadcast(plan.emotion, audio);
  }, []);
  const { trigger } = useBroadcastSocket(onBroadcast);

  const unlock = () => {
    stageRef.current?.unlockAudio();
    setAudioOn(true);
  };
  const test = (severity: string) => {
    unlock(); // 點測試鈕本身就是 user gesture，順便解鎖音訊
    trigger(severity);
  };

  return (
    <div className="relative h-full w-full overflow-hidden">
      <AvatarStage ref={stageRef} />

      <header className="absolute left-4 top-4 z-10 flex max-w-[92vw] flex-col gap-2 drop-shadow">
        <h1 className="text-lg font-bold text-slate-100">Augur · SOC 播報</h1>
        <SeverityIndicator />

        <button
          onClick={unlock}
          className={`w-fit rounded px-3 py-1 text-sm ring-1 ${
            audioOn
              ? "bg-slate-700 text-sev-resolved ring-slate-500"
              : "bg-slate-800 text-sev-info ring-slate-600 hover:bg-slate-700"
          }`}
        >
          {audioOn ? "🔊 語音已啟動" : "▶ 啟動播報語音"}
        </button>

        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">測試播報：</span>
          {TESTS.map((t) => (
            <button
              key={t.severity}
              onClick={() => test(t.severity)}
              className={`rounded px-2 py-1 text-xs font-bold text-slate-900 ${t.cls} hover:opacity-90`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <p className="hidden max-w-[420px] text-xs text-slate-500 sm:block">
          正式告警由 Grafana webhook 經導播推播（<code>pnpm mock</code> 亦可）。切換 avatar：
          <code>?avatar=vrm</code> / <code>?avatar=live2d</code>。
        </p>
      </header>

      <aside className="absolute bottom-4 right-4 z-10">
        <BroadcastFeed />
      </aside>

      <GrafanaPanel />
    </div>
  );
}
