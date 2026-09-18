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
import { probeDashboardDom, type DashboardDom } from '../dom/dashboardPanels';
import { DiagnosticAvatar } from '../avatar/DiagnosticAvatar';
import type { AvatarController } from '../avatar/AvatarController';
import { CENTER_CELL, gazeCell } from '../avatar/gaze';

interface Props extends PanelProps<MascotPanelOptions> {}

/**
 * 導播 + 呈現。這是舊架構 `src/server.ts:68-77` 那段處理迴圈的搬家：
 * 來源 → severity 過濾 → dedup 防洪 → BroadcastPlan → sink。
 * seam 相同、方向相反（push 變 pull），sink 從 WebSocket 變成瀏覽器語音合成器。
 *
 * 互動層（ADR-004 決策 6）採**漸進降級**：能看到別的 panel 就追全頁滑鼠、
 * 認得出點到哪一個 panel；看不到就把兩者限縮在自己的容器內。
 * 降級狀態顯示在畫面上 —— 不顯示的話 G-ADR004-4 沒有東西可以驗。
 */
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
  scopeChip: css`
    font-size: 10px;
    padding: 1px 7px;
    border-radius: 999px;
    border: 1px solid currentColor;
    opacity: 0.75;
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
  const avatarRef = useRef<AvatarController | null>(null);
  const domRef = useRef<DashboardDom | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(false);
  const gazeRef = useRef(CENTER_CELL);

  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [emotion, setEmotion] = useState<Emotion>('calm');
  const [speechErr, setSpeechErr] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [scope, setScope] = useState<{ cross: boolean; reason: string }>({ cross: false, reason: '偵測中' });
  const [lastClick, setLastClick] = useState<string | null>(null);

  const { minSeverity, repeatFiringMin, fallbackSeverity, alertLang, enableTTS, ttsVoice } = options;

  // ---- avatar ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const a = new DiagnosticAvatar();
    a.mount(host);
    avatarRef.current = a;
    return () => {
      a.dispose();
      avatarRef.current = null;
    };
  }, []);

  // ---- 互動層：能力偵測 + 漸進降級 ----
  useEffect(() => {
    const host = hostRef.current;
    const dom = probeDashboardDom(host);
    domRef.current = dom;
    setScope({ cross: dom.crossPanel, reason: dom.reason });

    // 降級的全部內容就是這一行：監聽 document 還是只監聽自己的容器。
    // 其餘邏輯完全相同 —— 這是「壞掉時少一個功能，而不是整個 plugin 炸掉」的關鍵。
    const target: Document | HTMLElement | null = dom.crossPanel ? document : host;
    if (!target) {
      return;
    }

    let raf = 0;
    let px = 0;
    let py = 0;
    const onMove = (ev: Event) => {
      const e = ev as PointerEvent;
      px = e.clientX;
      py = e.clientY;
      if (raf) {
        return;
      }
      raf = requestAnimationFrame(() => {
        raf = 0;
        const el = hostRef.current;
        if (!el) {
          return;
        }
        const r = el.getBoundingClientRect();
        const next = gazeCell(px - (r.left + r.width / 2), py - (r.top + r.height / 2), gazeRef.current);
        if (next !== gazeRef.current) {
          gazeRef.current = next;
          avatarRef.current?.setGaze(next);
        }
      });
    };

    const onClick = (ev: Event) => {
      const e = ev as PointerEvent;
      const hit = dom.panelAt(e.clientX, e.clientY);
      if (hit) {
        setLastClick(`${hit.key}${hit.pluginId ? ` · ${hit.pluginId}` : ''}`);
      } else if (!dom.crossPanel) {
        setLastClick('本 panel（已降級，看不到其他 panel）');
      }
    };

    target.addEventListener('pointermove', onMove, { passive: true });
    target.addEventListener('click', onClick, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('click', onClick);
      domRef.current = null;
    };
  }, []);

  // ---- 導播管線 ----
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
        onStart: () => {
          setSpeechErr(null);
          avatarRef.current?.setSpeaking(true);
        },
        onEnd: () => {
          avatarRef.current?.setSpeaking(false);
          setPending(speakerRef.current?.pending() ?? 0);
        },
        // 實測中文為詞級 boundary（1.53 次/秒、charLength 1–14）。
        // charLength 0 是句首標記不是詞，不當嘴型觸發。
        onBoundary: ({ charLength }) => {
          if (charLength > 0) {
            avatarRef.current?.setMouthOpen?.(Math.min(1, 0.35 + charLength / 14));
          }
        },
        onError: (e) => {
          setSpeechErr(e);
          avatarRef.current?.setSpeaking(false);
        },
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
    if (!source || !dedup || busyRef.current) {
      return;
    }
    busyRef.current = true;

    const alertState = (data as unknown as { alertState?: { dashboardUID?: string } }).alertState;

    void source
      .evaluate(alertState, alertState?.dashboardUID)
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
        avatarRef.current?.setEmotion(plans[0]!.plan.emotion);
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

  const unlock = useCallback(() => speakerRef.current?.unlock(), []);

  const chipColor = theme.visualization.getColorByName(
    ({ calm: 'blue', warning: 'orange', critical: 'red', resolved: 'green' } as const)[emotion]
  );
  const roomy = width >= 320 && height >= 180;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div ref={hostRef} style={{ color: chipColor, flex: '0 0 auto' }} />
        <span
          className={styles.chip}
          style={{ background: chipColor, color: theme.colors.getContrastText(chipColor) }}
        >
          {emotion}
        </span>
        {pending > 0 && <span className={styles.chip}>佇列 {pending}</span>}
        <span className={styles.scopeChip} title={scope.reason || '看得到其他 panel'}>
          {scope.cross ? '全頁追蹤' : '限本 panel'}
        </span>
        {roomy && (
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

      {lastClick && <div className={styles.when}>最後點擊：{lastClick}</div>}

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
