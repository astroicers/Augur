import { useCallback, useEffect, useRef } from "react";
import { useBroadcastStore, type Plan } from "../store/broadcastStore";

const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? "ws://localhost:3002";

interface BroadcastMsg {
  type: string;
  plan: Plan;
  audio?: string;
}

/**
 * 連上導播 WS（重連內建）。收到 broadcast → 更新 store + 呼叫 onBroadcast（播音 + 表情
 * 由 AvatarStage 處理）。回傳 trigger(severity) 供「測試播報」鈕經 WS 觸發示範播報
 * （dev/demo；director 端 allowDevTrigger 控制）。onBroadcast 需為穩定 ref（useCallback）。
 */
export function useBroadcastSocket(onBroadcast: (plan: Plan, audio: string) => void): {
  trigger: (severity: string) => void;
} {
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const { setConnected, pushBroadcast } = useBroadcastStore.getState();
    let stop = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!stop) retry = setTimeout(connect, 1000);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string) as BroadcastMsg;
        if (msg.type === "broadcast") {
          pushBroadcast(msg.plan);
          onBroadcast(msg.plan, msg.audio ?? "");
        }
      };
    };
    connect();
    return () => {
      stop = true;
      clearTimeout(retry);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [onBroadcast]);

  const trigger = useCallback((severity: string) => {
    wsRef.current?.send(JSON.stringify({ type: "trigger", severity }));
  }, []);

  return { trigger };
}
