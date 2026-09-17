import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LoadingState, PanelProps } from '@grafana/data';
import { css } from '@emotion/css';
import { useStyles2, useTheme2 } from '@grafana/ui';
import type { MascotPanelOptions } from '../panelOptions';
import type { BroadcastPlan, Emotion } from '../core/types';
import { meetsMin } from '../core/severity';
import { createDedup, type Dedup } from '../core/dedup';
import { buildBroadcastPlan } from '../core/format';
import { createPanelAlertSource, type PanelAlertSource } from '../sources/panelAlerts';
import { fetchPanelRules } from '../sources/rulesFetcher';
import { createSpeaker, type Speaker } from '../speech/speaker';

interface Props extends PanelProps<MascotPanelOptions> {}

/**
 * 導播 + 呈現。這是舊架構 `src/server.ts:68-77` 那段處理迴圈的搬家：
 * 來源 → severity 過濾 → dedup 防洪 → BroadcastPlan → sink。
 * 差別只在 sink 從 WebSocket 變成瀏覽器的語音合成器，而整段跑在 panel 裡。
 *
 * ⚠️ 還沒有精靈圖 —— avatar 是 P5，素材待產。現在呈現的是狀態與播報記錄，
 *    讓 G-ADR004-2（真告警端到端）與 -3（防洪）可以被驗。
 */
const EMOTION_COLOR: Record<Emotion, 'green' | 'orange' | 'red' | 'blue'> = {
  calm: 'blue',
  warning: 'orange',
  critical: 'red',
  resolved: 'green',
};

const getStyles = () => ({
  wrap: css`
    height: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow: hidden;
  `,
  head: css`
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  `,
  chip: css`
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    letter-spacing: 0.02em;
  `,
  mouth: css`
    width: 10px;
    border-radius: 2px;
    transition: height 90ms linear;
  `,
  mouthBox: css`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 14px;
    height: 16px;
  `,
  feed: css`
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  `,
  line: css`
    display: flex;
    gap: 6px;
    align-items: baseline;
    padding: 3px 6px;
    border-radius: 3px;
    background: rgba(127, 127, 127, 0.1);
  `,
  when: css`
    font-family: ui-monospace, monospace;
    font-size: 10px;
    opacity: 0.6;
    flex-shrink: 0;
  `,
  empty: css`
    opacity: 0.55;
    font-size: 12px;
    font-style: italic;
  `,
  btn: css`
    font: inherit;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 3px;
    cursor: pointer;
    border: 1px solid currentColor;
    background: transparent;
    color: inherit;
  `,
});

interface FeedLine {
  key: string;
  when: string;
  plan: BroadcastPlan;
}

export const MascotPanel: React.FC<Props> = ({ data, options, id, width, height }) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();

  // D10：一律 useRef 而非 useMemo —— React 18 StrictMode 會重跑 useMemo，
  // 重建 dedup 等於清空它的 Map，下一個 refresh 就會重念一次。
  const sourceRef = useRef<PanelAlertSource | null>(null);
  const dedupRef = useRef<Dedup | null>(null);
  const speakerRef = useRef<Speaker | null>(null);
  const busyRef = useRef(false);

  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [emotion, setEmotion] = useState<Emotion>('calm');
  const [mouth, setMouth] = useState(0);
  const [speechErr, setSpeechErr] = useState<string | null>(null);
  const [pending, setPending] = useState(0);

  // 只在真正影響行為的 option 變動時重建。
  const { minSeverity, repeatFiringMin, fallbackSeverity, alertLang, enableTTS, ttsVoice } = options;

  useEffect(() => {
    sourceRef.current = createPanelAlertSource({
      panelId: id,
      fetchRules: fetchPanelRules,
      fallbackSeverity,
    });
    return () => {
      sourceRef.current = null;
    };
  }, [id, fallbackSeverity]);

  useEffect(() => {
    // repeatFiringMin = 0 → 永不重播。createDedup 的窗就是 Infinity。
    const windowSec = repeatFiringMin > 0 ? repeatFiringMin * 60 : Number.POSITIVE_INFINITY;
    const d = createDedup(windowSec, { startCleanup: false });
    dedupRef.current = d;
    return () => {
      d.close();
      dedupRef.current = null;
    };
  }, [repeatFiringMin]);

  useEffect(() => {
    if (!enableTTS || typeof window === 'undefined' || !window.speechSynthesis) {
      speakerRef.current = null;
      return;
    }
    const sp = createSpeaker(window.speechSynthesis, {
      ...(ttsVoice ? { preferredVoice: ttsVoice } : {}),
      lang: alertLang === 'en' ? 'en-US' : 'zh-TW',
      events: {
        onStart: () => setSpeechErr(null),
        onEnd: () => {
          setMouth(0);
          setPending(speakerRef.current?.pending() ?? 0);
        },
        // 實測中文為詞級 boundary（1.53 次/秒、charLength 1–14）。
        // charLength 0 是句首標記不是詞，不當嘴型觸發。
        onBoundary: ({ charLength }) => {
          if (charLength > 0) {
            setMouth(Math.min(1, 0.35 + charLength / 14));
            window.setTimeout(() => setMouth(0.1), 180);
          }
        },
        onError: (e) => setSpeechErr(e),
      },
    });
    speakerRef.current = sp;
    return () => {
      sp.dispose();
      speakerRef.current = null;
    };
  }, [enableTTS, ttsVoice, alertLang]);

  useEffect(() => {
    // D10：載入中或查詢失敗時 data.series 可能是空的。在 threshold 路徑上
    // 那會被讀成「全部回到 base step」→ 對每個 episode 送 resolved
    // → 資料庫連不上竟然播「告警已恢復」。這是 pull 模型最容易踩的誤報。
    if (data.state !== LoadingState.Done) {
      return;
    }
    const source = sourceRef.current;
    const dedup = dedupRef.current;
    if (!source || !dedup) {
      return;
    }
    // evaluate 是 async（要打 rules 端點）。同一時間只跑一輪，
    // 避免 refresh 比端點快時兩輪交錯把 episode map 寫壞。
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;

    const alertState = (data as unknown as { alertState?: { dashboardUID?: string } }).alertState;
    const dashboardUid = alertState?.dashboardUID;

    void source
      .evaluate(alertState, dashboardUid)
      .then((alerts) => {
        const plans: FeedLine[] = [];
        for (const a of alerts) {
          // 順序與舊 server.ts 相同：先過濾、再防洪、最後才組播報計畫。
          // resolved 不受嚴重度門檻影響 —— 播過 firing 就該播恢復。
          if (a.status === 'firing' && !meetsMin(a.severity, minSeverity)) {
            continue;
          }
          if (!dedup.shouldSpeak(a)) {
            continue;
          }
          const plan = buildBroadcastPlan(a, alertLang);
          plans.push({
            key: `${a.fingerprint}:${a.status}:${plans.length}:${Date.now()}`,
            when: new Date().toLocaleTimeString(),
            plan,
          });
        }
        if (!plans.length) {
          return;
        }
        setFeed((prev) => [...plans.reverse(), ...prev].slice(0, 20));
        setEmotion(plans[0]!.plan.emotion);
        const sp = speakerRef.current;
        if (sp) {
          for (const p of plans) {
            sp.enqueue(p.plan);
          }
          setPending(sp.pending());
        }
      })
      .finally(() => {
        busyRef.current = false;
      });
  }, [data, minSeverity, alertLang]);

  const unlock = useCallback(() => {
    speakerRef.current?.unlock();
  }, []);

  const chipColor = theme.visualization.getColorByName(EMOTION_COLOR[emotion]);
  const compact = width < 260 || height < 160;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.mouthBox} title="嘴型（由 onboundary 驅動）">
          <div
            className={styles.mouth}
            style={{ height: `${2 + mouth * 12}px`, background: chipColor }}
          />
        </div>
        <span className={styles.chip} style={{ background: chipColor, color: theme.colors.getContrastText(chipColor) }}>
          {emotion}
        </span>
        {pending > 0 && <span className={styles.chip}>佇列 {pending}</span>}
        {!compact && (
          <button className={styles.btn} onClick={unlock} type="button">
            啟用語音
          </button>
        )}
        {speechErr && (
          <span className={styles.chip} style={{ color: theme.colors.error.text }}>
            {speechErr}
          </span>
        )}
      </div>

      <div className={styles.feed}>
        {feed.length === 0 ? (
          <span className={styles.empty}>尚無播報。持續 firing 只會念一次 —— 那是 dedup 在生效。</span>
        ) : (
          feed.map((l) => (
            <div key={l.key} className={styles.line}>
              <span className={styles.when}>{l.when}</span>
              <span>{l.plan.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
