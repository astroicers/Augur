import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LoadingState, PanelProps } from '@grafana/data';
import { css } from '@emotion/css';
import { useStyles2, useTheme2 } from '@grafana/ui';
import type { MascotPanelOptions } from '../panelOptions';
import type { BroadcastPlan, Emotion } from '../core/types';
import { meetsMin } from '../core/severity';
import { createDedup, type Dedup } from '../core/dedup';
import { buildBroadcastPlan } from '../core/format';
import { createPanelAlertSource, type AlertStateLike, type PanelAlertSource } from '../sources/panelAlerts';
import { fetchPanelRules } from '../sources/rulesFetcher';
import { createSpeaker, type Speaker } from '../speech/speaker';
import { probeDashboardDom, type DashboardDom } from '../dom/dashboardPanels';
import { DiagnosticAvatar } from '../avatar/DiagnosticAvatar';
import type { AvatarController } from '../avatar/AvatarController';
import { CENTER_CELL, DEFAULT_GAZE, gazeCell } from '../avatar/gaze';
import { createFlapDriver, type FlapDriver } from '../avatar/flap';
import { gazeDeadZonePx, spriteSide } from '../avatar/spriteSheet';

/** 三分鐘沒有新播報就回 calm —— 否則一則 resolved 播完，臉會頂著閃光停在那裡直到下一次告警。 */
const EMOTION_DECAY_MS = 3 * 60 * 1000;

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
  body: css`
    display: flex;
    gap: 10px;
    flex: 1 1 auto;
    min-height: 0;
  `,
  /*
   * ⚠️ 這裡**不能**有 \`align-items: flex-start\`。
   * 它會讓 feed 這個 flex item 收縮成內容高度，於是 \`overflow-y: auto\` 永遠不觸發 ——
   * 在真 Grafana 上實測：602×398 的 panel 塞 20 行播報，feed 的 clientHeight 與
   * scrollHeight 都是 950px（不可捲動），而 panel 底只到 503px，**583px 的內容被切掉且沒有捲軸**。
   * stage 自己用 \`align-self: flex-start\` 固定在上緣，不需要父層代勞。
   */
  bodyStacked: css`
    flex-direction: column;
  `,
  /**
   * SP-1.8 的方形 stage。寬高由 `MascotPanel` 顯式設定（見下方 `stageSide`），
   * **契約不新增 `setSize()`** —— SP-8.17 明文要求避免再開一次 ADR-004 決策 5 的介面異動。
   * `aspect-ratio: 1` 是保險：顯式寬高已經是方的，但若日後有人只改一邊，這裡會把它拉回來。
   */
  stage: css`
    flex: 0 0 auto;
    aspect-ratio: 1;
    align-self: flex-start;
  `,
  feed: css`
    flex: 1 1 auto;
    min-width: 0;
    /* flex item 的預設 min-height 是 auto（＝內容高度），不歸零的話 overflow 不會生效。 */
    min-height: 0;
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
  const flapRef = useRef<FlapDriver | null>(null);

  const [feed, setFeed] = useState<FeedLine[]>([]);
  const [emotion, setEmotion] = useState<Emotion>('calm');
  const [speechErr, setSpeechErr] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [scope, setScope] = useState<{ cross: boolean; reason: string }>({ cross: false, reason: '偵測中' });
  const [lastClick, setLastClick] = useState<string | null>(null);
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  // ⚠️ speaking 先前**只經 avatarRef.setSpeaking 送出去，React 側沒留** ——
  // 而 pending 的顯示條件含「未播報」，沒有這個 state 就判不出來。
  const [speaking, setSpeaking] = useState(false);
  const [stateSeenAt, setStateSeenAt] = useState<string | null>(null);
  const pendingShownRef = useRef(false);
  const lastRawStateRef = useRef<string | null>(null);

  /**
   * SP-1.9：視窗被拖到另一台 dpr 不同的螢幕時，`devicePixelRatio` 會變，
   * 但 React 不會因此重繪 —— `PanelProps` 的 width/height 是 CSS px，兩邊都沒動。
   * 不監聽的後果是 stage 停在舊 dpr 算出的邊長，在高 dpr 螢幕上會變成放大取樣
   * （SP-1.8：放大 1.875× 銳利度掉 56%）。
   *
   * `(resolution: Ndppx)` 是**精確比對**，所以每次 dpr 變了都要重建這個 query ——
   * 這就是 dpr 自己在相依陣列裡的原因，不是漏寫的迴圈。
   */
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    }
    return undefined;
  }, [dpr]);

  const { minSeverity, repeatFiringMin, fallbackSeverity, alertLang, enableTTS, ttsVoice } = options;

  /**
   * `alertState.state` 的原值。
   *
   * ⚠️ **不繞經 `panelAlerts.evaluate`** —— 它對 pending 回 `[]` 是**正確行為**
   * （pending 與 alerting 共用 fingerprint，先播 pending 會讓真的燒起來那一刻被 dedup
   * 吞掉，把最重要的事件降級成「可能要燒」）。pending 是**表情**不是**播報**，
   * 兩者走不同的路，這是刻意的分岔不是重複讀取。
   */
  const rawAlertState = (data as unknown as { alertState?: AlertStateLike }).alertState?.state ?? null;

  /**
   * 觀測出口（A2 唯一的量測管道）。記下 `alertState.state` 每次**變動**的時戳。
   * 永久顯示而非藏在 panel option 後面，理由與 scope chip 相同 ——
   * 看不見的降級等於沒有降級，看不見的狀態等於量不到。
   */
  useEffect(() => {
    if (rawAlertState === lastRawStateRef.current) {
      return;
    }
    lastRawStateRef.current = rawAlertState;
    setStateSeenAt(new Date().toLocaleTimeString());
  }, [rawAlertState]);

  // ---- avatar ----
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    const a = new DiagnosticAvatar();
    a.mount(host);
    avatarRef.current = a;
    flapRef.current = createFlapDriver((open) => a.setMouthOpen?.(open));
    return () => {
      flapRef.current?.stop();
      flapRef.current = null;
      a.dispose();
      avatarRef.current = null;
    };
  }, []);

  /**
   * pending 反應。三個條件缺一不可：
   *  - `state === 'pending'`：alert rule 的 `for` duration 期間
   *  - `emotion === 'calm'`：它不該跟 critical 搶同一張臉
   *  - `!speaking`：播報當下嘴與眉都在動，再疊一張緊繃臉只會互相打架
   *
   * **只在轉換時呼叫 `setReaction`**（`pendingShownRef`）。每次依賴變動都無條件
   * 呼叫 `setReaction(null)` 會把正在顯示的 click 反應（420ms）掃掉。
   *
   * ⚠️ **這個 effect 必須宣告在上面的 avatar mount effect 之後。** React 依宣告順序
   * 跑 effect，放在前面的話第一次 mount 時 `avatarRef.current` 還是 null 而提早 return，
   * 之後依賴沒再變就**永遠不會補跑** —— 症狀是 pending 表情整個功能靜默失效。
   * 這是實作時真的犯過的錯，由 MascotPanel.test.tsx 的第一條 pending 測試抓到。
   */
  useEffect(() => {
    const a = avatarRef.current;
    if (!a?.setReaction) {
      return;
    }
    const show = rawAlertState === 'pending' && emotion === 'calm' && !speaking;
    if (show === pendingShownRef.current) {
      return;
    }
    pendingShownRef.current = show;
    a.setReaction(show ? 'pending' : null);
  }, [rawAlertState, emotion, speaking]);


  // 情緒衰減。沒有這個，一則 resolved 播完後臉會頂著閃光停到下一次告警。
  useEffect(() => {
    if (emotion === 'calm') {
      return;
    }
    const h = window.setTimeout(() => {
      setEmotion('calm');
      avatarRef.current?.setEmotion('calm');
    }, EMOTION_DECAY_MS);
    return () => window.clearTimeout(h);
  }, [emotion, feed]);

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
        // dead zone 必須跟著 stage 大小走。寫死 28px 是為 DiagnosticAvatar 的 ~34px
        // 訂的，換成 128–256px 的精靈圖 stage 後，游標停在角色臉上時角色會把視線
        // 甩開自己 —— 「中央格＝游標壓在身上」的語意整個反過來。
        const next = gazeCell(px - (r.left + r.width / 2), py - (r.top + r.height / 2), gazeRef.current, {
          ...DEFAULT_GAZE,
          // 量測 rect 而不是用算出來的 stageSide：兩者應該相等，但 rect 是畫面上的事實。
          // 公式只有一份，住在 spriteSheet.ts（SP-1.10）。
          deadZonePx: gazeDeadZonePx(Math.min(r.width, r.height)),
        });
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
      } else {
        return;
      }
      // 點擊回饋。420ms 後自動回復 —— 它是事件不是狀態。
      avatarRef.current?.setReaction?.('click');
      window.setTimeout(() => avatarRef.current?.setReaction?.(null), 420);
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
        // ⚠️ plan 必須用起來。先前寫成 `onStart: () => {}` 把它丟掉，
        // 結果一批三則時臉會定在 plans[0] 的情緒長達 42 秒（實測語速 5.6 字/秒、
        // 一則約 14 秒）—— 表情該跟著**正在念的那一則**走，不是跟著整批的第一則。
        onStart: (plan) => {
          setSpeechErr(null);
          setEmotion(plan.emotion);
          avatarRef.current?.setEmotion(plan.emotion);
          avatarRef.current?.setSpeaking(true);
          setSpeaking(true);
          // 引擎不吐 boundary 時的 fallback（ADR-004 決策 4 保留）。
          // 收到第一個 boundary 就會被 boundary() 接管。
          flapRef.current?.idle();
        },
        onEnd: () => {
          flapRef.current?.stop();
          avatarRef.current?.setSpeaking(false);
          setSpeaking(false);
          setPending(speakerRef.current?.pending() ?? 0);
        },
        // 實測中文為詞級 boundary。charLength 決定**擺動次數**而非振幅
        // （ADR-004 決策 4 的原意；見 flap.ts 檔頭）。
        // charLength 0 是句首標記不是詞，不當嘴型觸發。
        onBoundary: ({ charLength }) => {
          if (charLength > 0) {
            flapRef.current?.boundary(charLength);
          }
        },
        onError: (e) => {
          setSpeechErr(e);
          flapRef.current?.stop();
          avatarRef.current?.setSpeaking(false);
          setSpeaking(false);
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

    const alertState = (data as unknown as { alertState?: AlertStateLike }).alertState;

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
  // SP-1.8 / SP-1.9。dpr 是狀態而非每次 render 讀 window —— 視窗被拖到另一台螢幕時
  // React 不會因為 devicePixelRatio 變了而重繪，必須自己監聽。
  const side = spriteSide({ width, height, devicePixelRatio: dpr });
  // 「啟用語音」鈕的門檻與 stage 的門檻各自獨立、不共用（SP-1.8 末段明文）。
  const roomy = width >= 320 && height >= 180;
  // 左圖右 feed 的切換點。窄於此改為上下堆疊，否則 feed 會被擠成一條。
  const sideBySide = width >= 320;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
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
        <span
          className={styles.scopeChip}
          title="props.data.alertState.state 的原值（@internal）。實測可達的只有 alerting / pending / ok；它是黏著的，永不回 undefined。"
          data-testid="alert-state-chip"
        >
          alertState: {rawAlertState ?? '—'}
          {stateSeenAt ? ` @${stateSeenAt}` : ''}
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

      <div className={`${styles.body} ${sideBySide ? '' : styles.bodyStacked}`}>
        {/*
          ⚠️ **`side < 128 不渲染` 這一條刻意還沒做**（留到 B2-4 的 SpriteController）。
          現在掛在這裡的是 `DiagnosticAvatar`，它的 3×3 格是寫死 10px，放進 128px 的方形
          stage 不會跟著長大 —— 現在就落地「窄 panel 不渲染」會把目前畫面上**唯一看得見的
          視線指示器**整個藏掉，等於拿掉 G-ADR004-4 的目視證據。
        */}
        <div
          ref={hostRef}
          className={styles.stage}
          style={{ color: chipColor, width: side, height: side }}
        />

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
    </div>
  );
};
