import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LoadingState, PanelProps } from '@grafana/data';
import { css } from '@emotion/css';
import { useStyles2, useTheme2 } from '@grafana/ui';
import type { MascotPanelOptions } from '../panelOptions';
import type { BroadcastPlan, Emotion } from '../core/types';
import { parseSeverityAliases } from '../core/severityAliases';
import {
  createBroadcastDirector,
  panelAlertSource,
  type BroadcastDirector,
  type DirectorSettings,
} from '../director/BroadcastDirector';
import type { AlertStateLike } from '../sources/panelAlerts';
import { fetchPanelRules } from '../sources/rulesFetcher';
import { HISTORY_DISPLAY_LIMIT, HISTORY_FETCH_LIMIT, historyToEntries, type HistoryResult } from '../sources/history';
import { fetchPanelHistory } from '../sources/historyFetcher';
import { createSpeaker, type Speaker, type SpeakerEvents } from '../speech/speaker';
import { createRemoteSpeaker } from '../speech/remoteSpeaker';
import { watchDashboardDom, type DashboardDom } from '../dom/dashboardPanels';
import { DiagnosticAvatar } from '../avatar/DiagnosticAvatar';
import { CLICK_REACTION_MS, SpriteController } from '../avatar/SpriteController';
import type { AvatarController } from '../avatar/AvatarController';
import { CENTER_CELL, DEFAULT_GAZE, gazeCell } from '../avatar/gaze';
import { createFlapDriver, type FlapDriver } from '../avatar/flap';
import {
  SPRITE_GAZE_ORIGIN_Y,
  gazeDeadZonePx,
  reactionFor,
  shouldRenderSprite,
  spriteSide,
} from '../avatar/spriteSheet';

/**
 * 本分頁念過的一句，和紀錄裡同文字的一筆，時間差多少以內算「同一件事」。
 * 紀錄時間是 Grafana 評估出狀態變化的時刻；panel 要到下一次 refresh 才念，所以念出時刻會晚一些
 * （refresh 間隔＋評估間隔）。窗開寬一點無妨：同一條規則在十分鐘內又出現同一句，本來就是同一類事件。
 * 上限：refresh 間隔超過 10 分鐘時，同一事件可能同時出現一列紀錄列與一列本分頁列 —— 只是重複，資訊不錯。
 */
const SESSION_MATCH_WINDOW_MS = 10 * 60 * 1000;

/**
 * 每個瀏覽器自己的靜音開關（存在本機）。值班牆要出聲、座位上的人可能想安靜 —— 這不是 dashboard 的設定，
 * 是「我這台」的偏好，所以不放 panel 選項。同一個瀏覽器裡所有吉祥物 panel 共用。
 * 本機儲存可能被封鎖（無痕、清除網站資料），讀寫都包 try/catch，失敗就當作沒靜音、只在這次分頁內記得。
 */
const MUTE_STORAGE_KEY = 'augur-mascot-panel.muted';
/** 試聽句的 plan.name（只用來組 plan；判斷「是不是試聽」改看物件身分，見 PREVIEW_PLANS）。 */
const PREVIEW_NAME = 'preview';
/**
 * 試聽送出的 plan 物件。被擋下時不補念試聽 —— 用**物件身分**判斷，不用名字：
 * plan.name 就是告警名稱，一條真的叫 `preview` 的告警不該因此永遠不補念（複審 F7）。
 * 外部語音降級時回呼帶的也是同一個 plan 物件（remoteSpeaker 以物件身分轉交）。
 */
const PREVIEW_PLANS = new WeakSet<BroadcastPlan>();
/**
 * 補念的時間上限：被擋超過這麼久的句子不補。牆面螢幕可能好幾小時沒人點，
 * 第一次有人點下去不該補念幾十句過時的話（複審 F2）。
 */
const BLOCKED_REPLAY_WINDOW_MS = 10 * 60 * 1000;
/** 同一頁其他吉祥物 panel 的靜音同步事件（同分頁）；跨分頁靠瀏覽器的 storage 事件（複審 F4）。 */
const MUTE_EVENT = 'augur-mascot-panel:muted';
/** 外部語音被自動播放政策擋下時，remoteSpeaker 寫在聲線標籤裡的原因字串。 */
const AUTOPLAY_BLOCKED = 'autoplay-blocked';

function readMuted(): boolean {
  try {
    return window.localStorage.getItem(MUTE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_STORAGE_KEY, muted ? '1' : '0');
  } catch {
    /* 存不了就只在這次分頁內有效 */
  }
}

/** 三分鐘沒有新播報就回 calm —— 否則一則 resolved 播完，臉會頂著閃光停在那裡直到下一次告警。 */
const EMOTION_DECAY_MS = 3 * 60 * 1000;

interface Props extends PanelProps<MascotPanelOptions> {}

/**
 * 呈現 + 接線。導播那條管線（來源 → severity 過濾 → 防洪 → BroadcastPlan → sink）
 * 自 #58 起住在 `src/director/BroadcastDirector.ts`，不依賴 React；本檔只負責
 * 把 panel 的 props 與瀏覽器側的東西（播報器、avatar、靜音、DOM）接上去。
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
    /* SP-1.7：邊長要等於內容區，padding / border 一律為 0。 */
    padding: 0;
    border: 0;
    box-sizing: border-box;
  `,
  /** feed 欄：篩選框、提示與紀錄清單。min-width/min-height 歸零的理由同下方 feed。 */
  feedCol: css`
    flex: 1 1 auto;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  `,
  filter: css`
    font: inherit;
    font-size: 12px;
    padding: 3px 6px;
    border-radius: 3px;
    border: 1px solid rgba(127, 127, 127, 0.4);
    background: transparent;
    color: inherit;
  `,
  notice: css`
    font-size: 11px;
    opacity: 0.75;
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
  /** 念出的時刻（epoch ms）。紀錄模式要拿它和紀錄的時間比，判斷「這一句是不是已經在紀錄裡」。 */
  at: number;
  plan: BroadcastPlan;
}

export const MascotPanel: React.FC<Props> = ({ data, options, id, width, height }) => {
  const styles = useStyles2(getStyles);
  const theme = useTheme2();

  // D10：一律 useRef 而非 useMemo —— React 18 StrictMode 會重跑 useMemo，
  // 而導播裡那張「誰播過了」的 Map 被重建就等於清空，下一個 refresh 會重念一次。
  const speakerRef = useRef<Speaker | null>(null);
  const avatarRef = useRef<AvatarController | null>(null);
  const domRef = useRef<DashboardDom | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const gazeRef = useRef(CENTER_CELL);
  const flapRef = useRef<FlapDriver | null>(null);

  const [feed, setFeed] = useState<FeedLine[]>([]);
  // 靜音：state 給畫面，ref 給播報 effect 讀（不讓開關變動去重跑那個 effect）。
  const [muted, setMuted] = useState<boolean>(readMuted);
  const mutedRef = useRef(muted);
  // 被瀏覽器以 not-allowed 擋下的告警句（使用者還沒在頁面上互動過）。導播已把它們記為念過，
  // 不留下來的話就永遠不會再念；使用者按「點一下啟用語音」時重送。試聽句不收（那不是告警）。
  const blockedRef = useRef<Array<{ plan: BroadcastPlan; at: number }>>([]);
  // ADR-006：播報紀錄。history 有值＝紀錄模式；historyError 有值＝降級回本分頁 feed（決策 7）。
  const [history, setHistory] = useState<HistoryResult | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState('');
  // 每次讀取的序號：只採用最後一次發出的讀取結果。
  // 不能用「讀取中就跳過」—— 讀取中改了時間範圍或門檻，那次 refresh 會被吞掉，
  // dashboard 沒開 auto-refresh 時就一直停在舊範圍（複審 M3）。
  const historySeqRef = useRef(0);
  const [emotion, setEmotion] = useState<Emotion>('calm');
  const [speechErr, setSpeechErr] = useState<string | null>(null);
  const [pending, setPending] = useState(0);
  const [scope, setScope] = useState<{ cross: boolean; reason: string }>({ cross: false, reason: '偵測中' });
  const [lastClick, setLastClick] = useState<string | null>(null);
  /** 點擊回饋是**事件**：翻一個 state，420ms 後翻回來。要顯示什麼由反應層依優先序決定。 */
  const [clicking, setClicking] = useState(false);
  /**
   * 第幾次點擊。`clicking` 已經是 true 時再點一下，`setClicking(true)` 是同值、React 不重跑
   * 反應層 —— SpriteController 自己的 420ms 計時器就只從**第一下**算起，連點的後幾下沒有回饋。
   * 這個序號讓每一下都重送 'click'（SpriteController 收到會重啟自己的計時器）。
   */
  const [clickSeq, setClickSeq] = useState(0);
  const [dpr, setDpr] = useState(() => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1));
  // ⚠️ speaking 先前**只經 avatarRef.setSpeaking 送出去，React 側沒留** ——
  // 而 pending 的顯示條件含「未播報」，沒有這個 state 就判不出來。
  const [speaking, setSpeaking] = useState(false);
  const [stateSeenAt, setStateSeenAt] = useState<string | null>(null);
  /** 播報器挑到的聲線名稱（onVoice 回報）；null = 引擎預設。 */
  const [voiceName, setVoiceName] = useState<string | null>(null);
  // 使用者已經為「外部語音被擋」按過一次的那個聲線標籤。標籤要等下一次外部語音成功才會改回，
  // 不記下來的話按鈕會一直停在「點一下啟用語音」、按不到靜音（第二輪複審 N1）。標籤一旦不再是被擋，就清掉。
  const [autoplayAck, setAutoplayAck] = useState<string | null>(null);
  /** 目前送給 avatar 的反應種類。只在它**改變**時才呼叫 setReaction。 */
  const reactionRef = useRef<'click' | 'pending' | null>(null);
  /**
   * 反應層**想要**的值，與上面「已經送出的值」分開記。
   * avatar 會在 panel 存活期間被換掉（跨過 128px 門檻、或 sprite 降級成 DiagnosticAvatar），
   * 而反應層 effect 的依賴在那一刻沒變、不會重跑 —— 新的 avatar 由 mount effect 從這裡補送。
   */
  const wantReactionRef = useRef<'click' | 'pending' | null>(null);
  const clickTimerRef = useRef(0);
  /** 視線原點的 y（stage 高度的比例）。精靈圖用臉中心，DiagnosticAvatar 用 stage 中心。 */
  const gazeOriginYRef = useRef(0.5);
  /** 已經送給 avatar 的是第幾次點擊。與 `clickSeq` 不同時，同樣是 'click' 也要重送。 */
  const sentClickSeqRef = useRef(0);
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

  const { minSeverity, repeatFiringMin, fallbackSeverity, alertLang, enableTTS, ttsVoice, ttsPitch, ttsRate } = options;
  // 舊 dashboard 存的選項沒有這兩欄；Grafana 會補預設值，但不靠它。
  const ttsEndpoint = (options.ttsEndpoint ?? '').trim();
  const ttsTimeoutSec = options.ttsTimeoutSec ?? 30;
  // 嚴重度別名（#51）。舊 dashboard 的 JSON 沒有這個鍵 → 空字串 → 空表 → resolveSeverity
  // 是恆等函式，整條導播與門檻的行為與沒有這個選項時完全相同。
  // ⚠️ 相依陣列裡放的是**設定字串**，解析放在 effect 內 —— 解析結果是 `Map`，
  // 每次 render 都是新的物件參考，進了 deps 就會讓導播與紀錄兩個 effect 每輪重跑
  // （重新評估、重新打 history 端點）。D10 那條「一律 useRef 而非 useMemo」擋的是
  // 有狀態的物件；這裡連 memo 都不需要，解析是幾次 split，一輪評估跑一次就好。
  const severityAliasSpec = options.severityAliases ?? '';
  // 「目前數值」子句（#71）。舊 dashboard 的 JSON 沒有這個鍵 → `?? true` → 與沒有這個選項時
  // 完全相同。判斷不在這裡：元件只把它原樣帶進導播的每一輪設定與紀錄的參數，
  // 真正決定要不要組那一段的是 `core/format.ts`（播報與紀錄因此共用同一份判斷）。
  const speakValue = options.speakValue ?? true;
  // 值班靜音時段（#63）。**判斷不在這裡** —— 時段的解析與「現在算不算時段內」都在導播裡
  // （`parseQuietHours` / `isQuietAt`，以注入的時鐘判斷），本檔只負責把這兩個選項原樣帶進
  // 每一輪的設定。放進 effect 裡自己算的話，同一條交付閘門就會有兩個住處：
  // 每瀏覽器靜音（ADR-007）已經是導播的 `muted()`，排程靜音再留在元件就必然漂開。
  // 相依陣列刻意不含這兩個（理由同 `repeatFiringMin`，見下方 effect）。
  const quietHours = options.quietHours ?? '';
  const quietAllowCritical = options.quietAllowCritical ?? false;
  // 舊版存下來的 panel JSON 沒有這兩個鍵 —— 預設值補不到時當成空字串（= 內建素材）。
  const directionsImgUrl = options.directionsImgUrl ?? '';
  const reactionsImgUrl = options.reactionsImgUrl ?? '';

  // SP-1.8 / SP-1.9。dpr 是狀態而非每次 render 讀 window —— 視窗被拖到另一台螢幕時
  // React 不會因為 devicePixelRatio 變了而重繪，必須自己監聽。
  const side = spriteSide({ width, height, devicePixelRatio: dpr });

  /**
   * SP-8.7 的降級結果，**綁在當時的 URL 組合上**。改了 URL 就是一組新的圖，舊的失敗不再適用 ——
   * 用 key 比對而不是在 effect 裡重置 state，免得多一輪 render。
   */
  const spriteKey = `${directionsImgUrl.trim()}\n${reactionsImgUrl.trim()}`;
  const [spriteFault, setSpriteFault] = useState<{ key: string; reason: string; fatal: boolean } | null>(null);
  const fault = spriteFault?.key === spriteKey ? spriteFault : null;
  /**
   * 掛哪一個 avatar。`side < 128` 不渲染 sprite（SP-1.8；A3-5 移來的規則）——
   * 那個尺寸下視線與嘴窗都讀不出來，改掛 DiagnosticAvatar，視線指示器不會整個消失。
   * sprite 載入或幾何驗證失敗（SP-8.7 第 2/3 條）同樣退回 DiagnosticAvatar。
   */
  const useSprite = shouldRenderSprite(side) && !fault?.fatal;

  // 換 avatar 時要補送的狀態。ref 只在 effect 裡寫（render 期間寫 ref 會被 react-hooks/refs 擋下）；
  // ⚠️ 這兩個 effect 必須宣告在 avatar mount effect **之前**，同一次 commit 裡才會先同步再補送。
  const emotionRef = useRef<Emotion>('calm');
  const speakingRef = useRef(false);
  useEffect(() => {
    emotionRef.current = emotion;
  }, [emotion]);
  useEffect(() => {
    speakingRef.current = speaking;
  }, [speaking]);

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
    const a: AvatarController = useSprite
      ? new SpriteController({
          directionsUrl: directionsImgUrl,
          reactionsUrl: reactionsImgUrl,
          // 降級要顯示在畫面上（ADR-004 決策 6）。failed → useSprite 轉 false → 這個 effect 重跑、
          // 改掛 DiagnosticAvatar；degraded → sprite 留著（只剩視線層），只多一個 chip。
          onStatus: (st) =>
            setSpriteFault(
              st.state === 'ready' ? null : { key: spriteKey, reason: st.reason, fatal: st.state === 'failed' }
            ),
        })
      : new DiagnosticAvatar();
    a.mount(host);
    // 新的 avatar 從零開始。第一次 mount 時這些都是初值（無作用）；
    // 中途換實作時（跨過 128px、sprite 降級）不補送的話，臉會回到 calm、視線回中央、
    // 正在播報的嘴停住、pending 消失 —— 直到下一次對應的輸入才恢復。
    a.setEmotion(emotionRef.current);
    a.setGaze(gazeRef.current);
    if (speakingRef.current) {
      a.setSpeaking(true);
    }
    if (a.setReaction) {
      const want = wantReactionRef.current;
      if (want !== null) {
        a.setReaction(want);
      }
      reactionRef.current = want;
    }
    avatarRef.current = a;
    gazeOriginYRef.current = useSprite ? SPRITE_GAZE_ORIGIN_Y : 0.5;
    flapRef.current = createFlapDriver((open) => a.setMouthOpen?.(open));
    return () => {
      flapRef.current?.stop();
      flapRef.current = null;
      a.dispose();
      avatarRef.current = null;
      // ⚠️ 守門旗標必須跟著 avatar 一起重置，否則 StrictMode 的第二次 mount
      // 會以為「已經送過了」而讓新的 avatar 永遠停在 null。
      reactionRef.current = null;
      // ⚠️ **不在這裡清 click 計時器。** 這個 effect 換 avatar 時也會跑（deps 不是 []），
      // 而 420ms 計時器是 `clicking` 翻回 false 的唯一途徑：點擊後 420ms 內換 avatar
      // （跨過 128px、sprite 載入失敗、改 URL 選項）就會讓 click 卡住、pending 不再出現。
      // 計時器屬於建立它的互動層，unmount 時由那邊清。
    };
  }, [useSprite, directionsImgUrl, reactionsImgUrl, spriteKey]);

  /**
   * 反應層（click / pending）。**一個 effect 決定一切**，不是兩處各自呼叫 `setReaction`。
   *
   * 優先序來自 SP-4.0，實作在 `spriteSheet.ts` 的 `reactionFor()`：
   * click > 非 calm 情緒 > pending > 無。pending 額外要求「未播報」——
   * 播報當下嘴與眉都在動，再疊一張緊繃臉只會互相打架。
   *
   * ⚠️ **先前是兩處各自呼叫 `setReaction`，而那有三個各自獨立的錯：**
   * 1. click 的 420ms 計時器到期時**無條件**送 `setReaction(null)`。若當時 pending 仍成立，
   *    pending 表情就**永久**消失 —— 因為 pending 那邊的守門旗標還記著「已顯示」，
   *    依賴不變就不會再送一次。使用者點一下 panel（這個 panel 唯一提供的互動）
   *    就足以讓 pending 從此不再出現。
   * 2. 守門旗標不隨 avatar 的 effect cleanup 重置。React 18 StrictMode 會
   *    mount→unmount→mount：第一個（已 dispose 的）avatar 收到 'pending'，
   *    而真正在畫面上的第二個永遠是 null。任何人工驗證 pending 都會得到錯誤結論。
   * 3. click 的計時器沒有在 unmount 時清掉。
   *
   * ⚠️ **這個 effect 必須宣告在上面的 avatar mount effect 之後。** React 依宣告順序
   * 跑 effect，放在前面的話第一次 mount 時 `avatarRef.current` 還是 null 而提早 return，
   * 之後依賴沒再變就**永遠不會補跑** —— 症狀是整個反應層靜默失效。
   * 這是實作時真的犯過的錯，由 MascotPanel.test.tsx 的 pending 測試抓到。
   */
  useEffect(() => {
    const want = reactionFor({
      clicking,
      pending: rawAlertState === 'pending',
      emotion,
      speaking,
    });
    wantReactionRef.current = want;
    const a = avatarRef.current;
    if (!a?.setReaction) {
      return;
    }
    const newClick = want === 'click' && clickSeq !== sentClickSeqRef.current;
    if (want === reactionRef.current && !newClick) {
      return;
    }
    reactionRef.current = want;
    if (want === 'click') {
      sentClickSeqRef.current = clickSeq;
    }
    a.setReaction(want);
  }, [clicking, clickSeq, rawAlertState, emotion, speaking]);

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

  // ---- 互動層：能力偵測 + 漸進降級（降級後可恢復）----
  //
  // 偵測**不是**一次性的。mount 當下照的那張快照常常是暫時的（其他 panel 還沒 render 完、
  // 使用者等一下才展開收起來的 row），只探一次會把它變成永久判決：明明看得到別人了，
  // 卻永遠停在「限本 panel」。重試政策連同理由住在 dashboardPanels.ts 的 watchDashboardDom。
  //
  // ⚠️ 升回時**顯示與 listener target 必須一起換**，所以兩者都只在 `apply()` 裡動。
  // 分頭更新的話會出現「chip 寫全頁追蹤、事件卻仍只來自自己容器」——
  // 那比單純降級更糟：畫面在說謊，而 G-ADR004-4 要驗的就是這個 chip。
  useEffect(() => {
    const host = hostRef.current;

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
        // 降級中順手重探一次。游標在動代表畫面活著，是最便宜的「要不要再看一眼」訊號；
        // 計時器的有界重試窗（6 秒）過了之後，這條就是唯一的升回途徑。
        // 節流有兩層：這裡本來就只有一 frame 一次，watcher 自己還有時間窗。
        watcher.recheck();
        const el = hostRef.current;
        if (!el) {
          return;
        }
        const r = el.getBoundingClientRect();
        // dead zone 必須跟著 stage 大小走。寫死 28px 是為 DiagnosticAvatar 的 ~34px
        // 訂的，換成 128–256px 的精靈圖 stage 後，游標停在角色臉上時角色會把視線
        // 甩開自己 —— 「中央格＝游標壓在身上」的語意整個反過來。
        // 原點是臉中心不是 stage 中心（SPRITE_GAZE_ORIGIN_Y 的註解）：否則游標停在角色額頭上，他會往上看。
        const oy = r.top + r.height * gazeOriginYRef.current;
        const next = gazeCell(px - (r.left + r.width / 2), py - oy, gazeRef.current, {
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
      // ⚠️ 讀 domRef 而不是閉包變數：升回時換的是 domRef 裡那一份。
      // 閉包版會讓 listener 永遠用 mount 當下那份能力 —— 升回後 panelAt 仍固定回 null，
      // 於是「全頁追蹤」的 chip 底下，點別的 panel 顯示的還是「已降級」。
      const dom = domRef.current;
      const hit = dom?.panelAt(e.clientX, e.clientY) ?? null;
      if (hit) {
        setLastClick(`${hit.key}${hit.pluginId ? ` · ${hit.pluginId}` : ''}`);
      } else if (!dom?.crossPanel) {
        setLastClick('本 panel（已降級，看不到其他 panel）');
      } else {
        return;
      }
      // 不直接碰 setReaction —— 由上面的反應層依優先序決定。
      // 所以 click 結束時若 pending 仍成立，它會自己回到 pending 而不是 null。
      window.clearTimeout(clickTimerRef.current);
      setClicking(true);
      setClickSeq((n) => n + 1);
      clickTimerRef.current = window.setTimeout(() => setClicking(false), CLICK_REACTION_MS);
    };

    // 降級的全部內容就是這裡的 target：監聽 document 還是只監聽自己的容器。
    // 其餘邏輯完全相同 —— 這是「壞掉時少一個功能，而不是整個 plugin 炸掉」的關鍵。
    let target: Document | HTMLElement | null = null;
    const bind = (next: Document | HTMLElement | null) => {
      if (next === target) {
        return;
      }
      if (target) {
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('click', onClick);
      }
      target = next;
      target?.addEventListener('pointermove', onMove, { passive: true });
      target?.addEventListener('click', onClick, { passive: true });
    };

    /** 能力 → 顯示 ＋ listener target。這兩件事只在這裡動，就不可能不同步。 */
    const apply = (dom: DashboardDom) => {
      domRef.current = dom;
      setScope({ cross: dom.crossPanel, reason: dom.reason });
      bind(dom.crossPanel ? document : host);
    };

    const watcher = watchDashboardDom(host, apply);
    apply(watcher.current());

    return () => {
      // 三種東西都要清：計時器（watcher 的重試 ＋ click 的回饋）、raf、以及**目前**綁著的
      // listener。`bind(null)` 而不是對 host／document 各 remove 一次 —— 綁在哪由 bind 記著，
      // 升回過的那次就是綁在 document 上。
      watcher.stop();
      cancelAnimationFrame(raf);
      bind(null);
      window.clearTimeout(clickTimerRef.current);
      domRef.current = null;
    };
  }, []);

  // ---- 導播（接線）----
  //
  // 管線本體與它的四條不變量住在 `director/BroadcastDirector.ts`（#58）；
  // 本檔這一段只剩兩件事：把導播建起來（它自己持有 source 與 dedup），
  // 以及每輪 panel data 餵一次。先前這裡是四個 effect，而其中三條不變量靠
  // **宣告順序**維持（同步設定的 effect 要排在 evaluate 之前、source 與 dedup 的
  // deps 必須一致、換窗不得重建 dedup）—— 那三條現在由導播的呼叫順序與狀態保證，
  // 本檔不再有任何一條導播不變量依賴 effect 的先後。
  //
  // ⚠️ **導播刻意不在 effect 裡建立。** 在 effect 裡建就得排在下面那個 effect 之前，
  // 否則第一次 commit 時 `directorRef.current` 還是 null、那一輪被整個跳過 ——
  // 也就是把剛拆掉的宣告順序依賴原封不動搬回來。改成「用的時候才取」之後，
  // 下面那個 effect 第一件事就是呼叫 `directorFor(id)`，拿到的一定是活的導播。
  const directorRef = useRef<BroadcastDirector | null>(null);
  /** 手上那個導播是為哪一個 panel id 建的（`id` 變了要換一個新的，連 source 與 dedup 一起）。 */
  const directorPanelRef = useRef<number | null>(null);
  const directorFor = useCallback((panelId: number): BroadcastDirector => {
    const held = directorRef.current;
    if (held && directorPanelRef.current === panelId) {
      return held;
    }
    held?.dispose();
    const next = createBroadcastDirector({
      createSource: panelAlertSource(panelId, fetchPanelRules),
      // 播報器與靜音都是**交付當下才讀**：換語音選項（重建播報器）或按靜音，
      // 都不該動到導播手上的 source／dedup。
      speaker: () => speakerRef.current,
      muted: () => mutedRef.current,
    });
    directorRef.current = next;
    directorPanelRef.current = panelId;
    return next;
  }, []);

  // 卸載時收掉導播。只有 cleanup、沒有 mount 行為，所以與其他 effect 的宣告順序無關。
  useEffect(
    () => () => {
      directorRef.current?.dispose();
      directorRef.current = null;
      directorPanelRef.current = null;
    },
    []
  );

  useEffect(() => {
    const hasSynth = typeof window !== 'undefined' && !!window.speechSynthesis;
    // 外部語音（ADR-005）不需要 speechSynthesis；沒有它時降級那一則會報錯，但不擋外部路徑。
    if (!enableTTS || typeof window === 'undefined' || (!hasSynth && !ttsEndpoint)) {
      speakerRef.current = null;
      return;
    }
    const events: SpeakerEvents & { onMouth?: (open: number) => void } = {
      onVoice: (name) => {
        setVoiceName(name);
        if (!(name ?? '').includes(AUTOPLAY_BLOCKED)) {
          setAutoplayAck(null);
        }
      },
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
      onError: (e, plan) => {
        if (e === 'not-allowed' && plan && !PREVIEW_PLANS.has(plan)) {
          // 寫入時就修剪（第二輪複審 N2）：丟掉超出補念時限的、同一則告警只留最新一筆。
          // 沒人點的牆面螢幕配上重播間隔時，清單才不會一直長。
          const now = Date.now();
          blockedRef.current = [
            ...blockedRef.current.filter((b) => b.at >= now - BLOCKED_REPLAY_WINDOW_MS && b.plan.name !== plan.name),
            { plan, at: now },
          ];
        }
        setSpeechErr(e);
        flapRef.current?.stop();
        avatarRef.current?.setSpeaking(false);
        setSpeaking(false);
      },
      // 外部語音才有：從音訊包絡來的幀級嘴型（ADR-005 決策 5）。
      // onStart 啟動的定速 flap 要先停掉，否則兩個來源輪流改嘴型。
      onMouth: (open) => {
        flapRef.current?.stop();
        avatarRef.current?.setMouthOpen?.(open);
      },
    };
    const webSpeech = (ev: SpeakerEvents): Speaker =>
      hasSynth
        ? createSpeaker(window.speechSynthesis, {
            ...(ttsVoice ? { preferredVoice: ttsVoice } : {}),
            lang: alertLang === 'en' ? 'en-US' : 'zh-TW',
            pitch: ttsPitch,
            rate: ttsRate,
            events: ev,
          })
        : unavailableSpeaker(ev);
    const sp = ttsEndpoint
      ? createRemoteSpeaker(
          {
            fetchFn: (u, init) => fetch(u, init),
            createAudioContext: () => new AudioContext(),
            createFallback: webSpeech,
            requestFrame: (cb) => requestAnimationFrame(cb),
            cancelFrame: (h) => cancelAnimationFrame(h),
          },
          { endpoint: ttsEndpoint, timeoutMs: ttsTimeoutSec * 1000, rate: ttsRate, events }
        )
      : webSpeech(events);
    speakerRef.current = sp;
    return () => {
      sp.dispose();
      speakerRef.current = null;
      // ⚠️ 播報中重建播報器（改任何一個語音選項）時，被 dispose 的那一則不會再送 onEnd／onError ——
      // 外部語音的世代檢查會把它們吞掉。不在這裡收尾的話 speaking 卡在 true：pending 表情被壓住、
      // 換 avatar 時補送 setSpeaking(true) 讓嘴巴無聲地動，直到下一則播完才自癒（2026-10-05 複審 F1）。
      // Web Speech 路徑也一樣：speaker.ts 的世代計數會吞掉 cancel() 之後晚到的 onerror，所以收尾一律在這裡做。
      flapRef.current?.stop();
      avatarRef.current?.setSpeaking(false);
      speakingRef.current = false;
      setSpeaking(false);
    };
  }, [enableTTS, ttsVoice, alertLang, ttsPitch, ttsRate, ttsEndpoint, ttsTimeoutSec]);

  useEffect(() => {
    // D10：載入中或查詢失敗時 data.series 可能是空的。在 threshold 路徑上
    // 那會被讀成「全部回到 base step」→ 對每個 episode 送 resolved
    // → 資料庫連不上竟然播「告警已恢復」。這是 pull 模型最容易踩的誤報。
    // 守門留在這裡而不是導播裡：只有本檔看得到 `data.state`。
    if (data.state !== LoadingState.Done) {
      return;
    }
    const alertState = (data as unknown as { alertState?: AlertStateLike }).alertState;
    // ⚠️ **dashboard uid 不能只從 alertState 拿。** alertState 是 `@internal`，
    // 而它的形狀**真的在 minor 版之間變過**（2026-10-01 實測，Grafana 原始碼逐 tag 比對）：
    // 12.3.0–12.3.11 的物件是 `{state,id,panelId,dashboardId}`（數字 id），
    // 12.4.0 起才是 `{…, dashboardUID}`。在 12.3.x 上讀 dashboardUID 得到 undefined
    // → rules 查詢被跳過 → 整條退到泛用降級：規則名與數值消失、warning 被念成 critical。
    // 後備用**公開**型別的 `data.request.dashboardUID`（@grafana/data 的 DataQueryRequest）——
    // 這正是 ADR-004 標過的 @internal 風險實際發生了一次，不要只靠那一個欄位。
    const dashboardUid = alertState?.dashboardUID ?? data.request?.dashboardUID;

    // 設定**隨呼叫帶進去**，不經任何 ref 或另一個 effect 同步：這一輪讀到的
    // 一定是本次 commit 的選項值。相依陣列刻意不含 `repeatFiringMin`、
    // `fallbackSeverity` 與 #63 的 `quietHours`／`quietAllowCritical`
    // （下方 eslint-disable 指的就是這四個）—— 它們只在這個
    // effect 真的跑的時候才被讀，而那一刻讀的是最新一輪 render 的閉包；
    // 放進 deps 只會讓「在編輯面板裡改那幾個選項」各多打一次 rules 端點。
    // 代價是改了它們要等下一輪 refresh 才生效，而靜音時段的邊界本來就只在
    // refresh 當下才被看一眼（時段結束不補念，所以沒有「錯過一輪」這回事）。
    // `speakValue`（#71）**在** deps 裡，與 `alertLang` 同一類：它改的是句子本身，
    // 在編輯面板裡撥了之後要能立刻看到新句子（紀錄那個 effect 同理）。
    const settings: DirectorSettings = {
      minSeverity,
      repeatFiringMin,
      fallbackSeverity,
      alertLang,
      speakValue,
      severityAliasSpec,
      quietHours,
      quietAllowCritical,
    };

    void directorFor(id)
      .evaluate({ alertState, dashboardUid }, settings)
      .then((round) => {
        if (round.items.length === 0) {
          return;
        }
        // ⚠️ **不要就地 `reverse()`** —— `round.items` 後面還有兩處要讀：
        //  1. `setEmotion(items[0])` 會拿到**最後**一則的情緒而不是第一則；
        //  2. 導播已經照時間順序交付給播報器了，順序對不上就查不出哪邊反了。
        // 另外它在 setState 的 updater 裡，StrictMode 的雙呼叫會反轉兩次而抵銷，
        // 於是開發模式與正式模式的 feed 順序不一樣 —— 最難查的那種。
        // feed 要新的在上，所以用一份複本反轉；情緒維持時間順序。
        const lines: FeedLine[] = round.items.map((item, i) => ({
          key: `${item.alert.fingerprint}:${item.alert.status}:${i}:${item.at}`,
          when: new Date(item.at).toLocaleTimeString(),
          at: item.at,
          plan: item.plan,
        }));
        const newestFirst = [...lines].reverse();
        setFeed((prev) => [...newestFirst, ...prev].slice(0, 20));
        setEmotion(round.items[0]!.plan.emotion);
        avatarRef.current?.setEmotion(round.items[0]!.plan.emotion);
        // 靜音或沒有播報器時導播不交付，`pending` 是 null —— 清單與表情照樣更新。
        if (round.pending !== null) {
          setPending(round.pending);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, id, minSeverity, alertLang, speakValue, severityAliasSpec, directorFor]);

  // ADR-006：每次 panel data 刷新就重讀一次這個 panel 的告警歷史。
  // ⚠️ 這裡的結果**只給 feed 顯示，永遠不進播報器、也不經導播**（決策 5）——
  // 否則每次重新整理，吉祥物都會把範圍內的舊告警重念一遍。
  useEffect(() => {
    if (data.state !== LoadingState.Done) {
      return;
    }
    const alertState = (data as unknown as { alertState?: AlertStateLike }).alertState;
    // 與導播 effect 同一套取法（12.3.x 的 alertState 沒有 dashboardUID）。
    const dashboardUid = alertState?.dashboardUID ?? data.request?.dashboardUID;
    const to = Number(data.timeRange?.to?.valueOf?.());
    const from = Number(data.timeRange?.from?.valueOf?.());
    const toMs = Number.isFinite(to) ? to : Date.now();
    const fromMs = Number.isFinite(from) ? from : toMs - 60 * 60 * 1000;
    const seq = ++historySeqRef.current;
    let cancelled = false;
    // 沒有 dashboard uid（例如還沒存檔的 dashboard）也走同一條非同步鏈，當成一次讀取失敗：
    // 在 effect 裡同步 setState 會觸發連鎖重繪（react-hooks lint）。
    const job = dashboardUid
      ? fetchPanelHistory(dashboardUid, id, fromMs, toMs)
      : Promise.reject(new Error('不在已存檔的 dashboard 裡'));
    // 過期的回應（期間又發了新的讀取）一律丟掉，不論它比新的早到還是晚到。
    void job
      .then((h) =>
        historyToEntries(h.raw, h.templates, {
          minSeverity,
          lang: alertLang,
          speakValue,
          aliases: parseSeverityAliases(severityAliasSpec).aliases,
        })
      )
      .then(
        (result) => {
          if (!cancelled && seq === historySeqRef.current) {
            setHistory(result);
            setHistoryError(null);
          }
        },
        (e: unknown) => {
          if (!cancelled && seq === historySeqRef.current) {
            setHistory(null);
            setHistoryError(errorText(e));
          }
        }
      );
    // unmount（或下一次讀取）時作廢這一次：晚到的結果不得再 setState。
    // 取捨（複審 F8）：data 轉成 Loading／Error 時這次讀取也會被作廢、且不發新讀取；
    // 查詢持續 Error 時紀錄停在上一次的結果，等下一次 Done 再讀。
    return () => {
      cancelled = true;
    };
  }, [data, id, minSeverity, alertLang, speakValue, severityAliasSpec]);

  // 套用靜音狀態（本 panel 的按鈕、同頁其他 panel、或其他分頁都會走這裡）。
  // 切到靜音：停掉正在念與排隊中的、嘴型驅動也停、嘴型歸零（stop 之後不會再有 onEnd，複審 F1）。
  // 切回開：叫醒引擎。同頁同步是在同一個 click 事件裡同步派送，仍算使用者手勢。
  const applyMuted = useCallback((next: boolean) => {
    if (mutedRef.current === next) {
      return;
    }
    mutedRef.current = next;
    setMuted(next);
    const sp = speakerRef.current;
    if (next) {
      blockedRef.current = [];
      sp?.stop();
      flapRef.current?.stop();
      avatarRef.current?.setMouthOpen?.(0);
      avatarRef.current?.setSpeaking(false);
      speakingRef.current = false;
      setSpeaking(false);
      setPending(sp?.pending() ?? 0);
    } else {
      sp?.unlock();
    }
  }, []);

  const toggleVoice = useCallback(
    (blocked: boolean) => {
      const sp = speakerRef.current;
      if (blocked) {
        // 瀏覽器擋著：這一下是使用者手勢，叫醒引擎、補念被擋的句子，狀態維持「開」（不是切成靜音）。
        // 補念只取最近 10 分鐘內的；同一則告警只留最後的狀態（被擋期間已恢復的就只念恢復句）（複審 F2）。
        sp?.unlock();
        if ((voiceName ?? '').includes(AUTOPLAY_BLOCKED)) {
          setAutoplayAck(voiceName);
        }
        const cutoff = Date.now() - BLOCKED_REPLAY_WINDOW_MS;
        const recent = blockedRef.current.filter((b) => b.at >= cutoff);
        blockedRef.current = [];
        const lastIndex = new Map<string, number>();
        recent.forEach((b, i) => lastIndex.set(b.plan.name, i));
        setSpeechErr(null);
        recent.forEach((b, i) => {
          if (lastIndex.get(b.plan.name) === i) {
            sp?.enqueue(b.plan);
          }
        });
        setPending(sp?.pending() ?? 0);
        return;
      }
      const next = !mutedRef.current;
      applyMuted(next);
      writeMuted(next);
      window.dispatchEvent(new CustomEvent<boolean>(MUTE_EVENT, { detail: next }));
    },
    [applyMuted, voiceName]
  );

  // 同頁其他吉祥物 panel 按了開關（MUTE_EVENT），或另一個分頁改了本機儲存（storage 事件）：跟著同步。
  useEffect(() => {
    const onMute = (e: Event) => applyMuted(Boolean((e as CustomEvent<boolean>).detail));
    const onStorage = (e: StorageEvent) => {
      if (e.key === MUTE_STORAGE_KEY) {
        applyMuted(e.newValue === '1');
      }
    };
    window.addEventListener(MUTE_EVENT, onMute);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(MUTE_EVENT, onMute);
      window.removeEventListener('storage', onStorage);
    };
  }, [applyMuted]);
  // 試聽：用目前的聲線、音高、語速念一句固定的話，方便在 panel 編輯畫面調聲音。
  const preview = useCallback(() => {
    speakerRef.current?.unlock();
    const plan: BroadcastPlan = {
      text: alertLang === 'en' ? 'Hi, I will read your alerts out loud.' : '嗨，我會幫你把告警念出來。',
      severity: 'info',
      emotion: 'calm',
      name: PREVIEW_NAME,
      status: 'firing',
    };
    PREVIEW_PLANS.add(plan);
    speakerRef.current?.enqueue(plan);
  }, [alertLang]);

  // 紀錄模式顯示告警歷史（ADR-006）；讀不到時退回本分頁念過的句子（決策 7）。
  const renderFeedLines = () => {
    if (history) {
      const q = historyFilter.trim().toLowerCase();
      // 本分頁念過、但紀錄裡沒有的句子：典型是範圍開始前就在燒的告警 —— 載入時照樣念，
      // 但那次狀態變化不在範圍內。不補上就會「念了、清單上卻找不到」。它們是剛念的，排在最上面。
      // 「已經在紀錄裡」要同文字**而且時間對得上**：紀錄時間在念出時刻前後的窗內。
      // 只比文字的話，數值沒變的 firing 或沒有數值的 resolved，會被幾小時前同文字的舊紀錄吃掉（複審 L3）。
      const sessionOnly = feed.filter(
        (l) => !history.entries.some((e) => e.text === l.plan.text && Math.abs(e.time - l.at) <= SESSION_MATCH_WINDOW_MS)
      );
      const rows = [
        ...sessionOnly.map((l) => ({
          key: l.key,
          origin: 'session',
          when: l.when,
          text: l.plan.text,
          search: l.plan.text.toLowerCase(),
        })),
        ...history.entries.map((e) => ({
          key: e.key,
          origin: 'history',
          when: formatWhen(e.time),
          text: e.text,
          search: e.search,
        })),
      ];
      const shown = q ? rows.filter((r) => r.search.includes(q)) : rows;
      if (!shown.length) {
        return <span className={styles.empty}>{q ? '沒有符合的紀錄。' : '這段時間範圍內沒有播報紀錄。'}</span>;
      }
      // data-origin 讓探測與測試分得出「紀錄列」與「本分頁念過的列」（複審 H1）。
      return shown.map((r) => (
        <div key={r.key} className={styles.line} data-origin={r.origin}>
          <span className={styles.when}>{r.when}</span>
          <span>{r.text}</span>
        </div>
      ));
    }
    if (!feed.length) {
      return <span className={styles.empty}>尚無播報。持續 firing 只會念一次 —— 那是 dedup 在生效。</span>;
    }
    return feed.map((l) => (
      <div key={l.key} className={styles.line} data-origin="session">
        <span className={styles.when}>{l.when}</span>
        <span>{l.plan.text}</span>
      </div>
    ));
  };

  const chipColor = theme.visualization.getColorByName(
    ({ calm: 'blue', warning: 'orange', critical: 'red', resolved: 'green' } as const)[emotion]
  );
  // SP-7.16：機械驗收只涵蓋內建的兩張 sheet。使用者自己填的圖要在畫面上標明。
  const customSprite = useSprite && (directionsImgUrl.trim() !== '' || reactionsImgUrl.trim() !== '');
  // 「啟用語音」鈕的門檻與 stage 的門檻各自獨立、不共用（SP-1.8 末段明文）。
  const roomy = width >= 320 && height >= 180;
  // 開著但瀏覽器擋著（使用者還沒在頁面上互動）：按鈕要邀請「啟用」，不能讓人一按就變靜音。
  // 外部語音（ADR-005）被自動播放政策擋下時不會丟錯誤，而是降級並把原因寫進聲線標籤；
  // 喚醒 AudioContext 需要在使用者手勢裡呼叫 unlock，所以也算「被擋」（複審 F3）。
  const voiceBlocked =
    !muted &&
    (speechErr === 'not-allowed' || ((voiceName ?? '').includes(AUTOPLAY_BLOCKED) && voiceName !== autoplayAck));
  // 左圖右 feed 的切換點。窄於此改為上下堆疊，否則 feed 會被擠成一條。
  const sideBySide = width >= 320;

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <span className={styles.chip} style={{ background: chipColor, color: theme.colors.getContrastText(chipColor) }}>
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
        {roomy && enableTTS && (
          <button
            className={styles.btn}
            onClick={() => toggleVoice(voiceBlocked)}
            type="button"
            aria-pressed={muted}
            data-testid="voice-toggle"
            title={
              muted
                ? '這個瀏覽器目前靜音；按一下恢復語音'
                : voiceBlocked
                  ? '瀏覽器在你點過頁面之前不准發聲；按一下啟用，剛才被擋掉的會補念'
                  : '按一下讓這個瀏覽器靜音（只影響你自己，重新整理後仍記得）'
            }
          >
            {muted ? '🔇 靜音中' : voiceBlocked ? '🔊 點一下啟用語音' : '🔊 語音開'}
          </button>
        )}
        {roomy && enableTTS && (
          <button className={styles.btn} onClick={preview} type="button" data-testid="tts-preview">
            試聽
          </button>
        )}
        {enableTTS && (
          <span
            className={styles.scopeChip}
            data-testid="voice-chip"
            title="目前用來播報的聲線。要換就在 panel 選項「指定聲線」填名稱的一段。"
          >
            聲線：{voiceName ?? '引擎預設'}
          </span>
        )}
        {speechErr && (
          <span className={styles.chip} style={{ color: theme.colors.error.text }}>
            {speechErr}
          </span>
        )}
        {customSprite && (
          <span
            className={styles.scopeChip}
            data-testid="sprite-custom-chip"
            title="panel option 指定了自訂精靈圖。tools/check-sprite-sheets.mjs 只驗內建的兩張，這組圖的格對齊沒有經過檢查（SP-7.16）。"
          >
            自訂圖，對齊未驗證
          </span>
        )}
        {fault && (
          <span
            className={styles.chip}
            style={{ color: theme.colors.warning.text }}
            data-testid="sprite-fault-chip"
            title={fault.reason}
          >
            {fault.fatal ? '精靈圖停用' : '精靈圖部分停用'}：{fault.reason}
          </span>
        )}
      </div>

      {lastClick && <div className={styles.when}>最後點擊：{lastClick}</div>}

      <div className={`${styles.body} ${sideBySide ? '' : styles.bodyStacked}`}>
        {/*
          stage 的邊長由這裡顯式設定（SP-8.17），avatar 只用 inset:0 填滿它。
          side < 128 時掛的是 DiagnosticAvatar 而不是不掛（見上面的 useSprite）——
          整個藏掉會拿掉畫面上唯一看得見的視線指示器，也就是 G-ADR004-4 的目視證據。
        */}
        <div
          ref={hostRef}
          className={styles.stage}
          data-testid="mascot-stage"
          style={{ color: chipColor, width: side, height: side }}
        />

        <div className={styles.feedCol}>
          {history && (
            <input
              className={styles.filter}
              value={historyFilter}
              onChange={(e) => setHistoryFilter(e.currentTarget.value)}
              placeholder="篩選紀錄（規則名、內容、主機、pod…）"
              aria-label="篩選播報紀錄"
            />
          )}
          {historyError && (
            <span className={styles.notice}>讀不到告警歷史：{historyError}。只顯示本分頁的播報。</span>
          )}
          {history?.truncated === 'display' && (
            <span className={styles.notice}>只顯示最新 {HISTORY_DISPLAY_LIMIT} 條，要看更早的請縮小時間範圍。</span>
          )}
          {history?.truncated === 'fetch' && (
            <span className={styles.notice}>
              這段範圍內的狀態變化超過 {HISTORY_FETCH_LIMIT} 筆，只讀了最新的部分，要看更早的請縮小時間範圍。
            </span>
          )}
          <div className={styles.feed}>{renderFeedLines()}</div>
        </div>
      </div>
    </div>
  );
};

/** 錯誤物件 → 給人看的一行原因。backendSrv 丟出來的是 `{ status, statusText, data: { message } }`。 */
function errorText(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  const r = e as { status?: number; statusText?: string; data?: { message?: string } } | undefined;
  const parts = [r?.status, r?.statusText, r?.data?.message].filter((x) => x !== undefined && x !== '');
  return parts.length ? parts.join(' ') : '未知錯誤';
}

/** 今天的紀錄只顯示時間；更早的連日期一起顯示，翻舊紀錄時才分得出是哪一天。 */
function formatWhen(time: number): string {
  const d = new Date(time);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString() : d.toLocaleString();
}

/** 沒有 speechSynthesis 的環境裡，外部語音降級時的接手者：每一則都直接報錯，佇列照走。 */
function unavailableSpeaker(ev: SpeakerEvents): Speaker {
  return {
    unlock() {},
    enqueue: (plan) => ev.onError?.('no-speech-synthesis', plan),
    pending: () => 0,
    isSpeaking: () => false,
    stop() {},
    voiceName: () => null,
    dispose() {},
  };
}
