import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LoadingState, PanelProps } from '@grafana/data';
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
import { buildFeedRows, type FeedLine, type FeedRow } from '../feed/feedRows';
import { isPanelEditor, skippedAliasNotice, suppressedMark } from '../feed/feedNotices';
import { FEED_CSV_MIME, feedCsvFilename, feedRowsToCsv } from '../feed/feedCsv';
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
import { unavailableSpeaker } from '../speech/unavailableSpeaker';
import { errorText } from '../sources/errorText';
import { getStyles } from './MascotPanel.styles';
import { useVoiceSwitch } from './useVoiceSwitch';

/** 試聽句的 plan.name（只用來組 plan；判斷「是不是試聽」改看物件身分，見 PREVIEW_PLANS）。 */
const PREVIEW_NAME = 'preview';
/**
 * 試聽送出的 plan 物件。被擋下時不補念試聽 —— 用**物件身分**判斷，不用名字：
 * plan.name 就是告警名稱，一條真的叫 `preview` 的告警不該因此永遠不補念（複審 F7）。
 * 外部語音降級時回呼帶的也是同一個 plan 物件（remoteSpeaker 以物件身分轉交）。
 */
const PREVIEW_PLANS = new WeakSet<BroadcastPlan>();
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
  // 告警名稱取自哪個 label（#69）。**純接線**：名字與 fingerprint 是來源層的職責
  // （`sources/panelAlerts.ts` 的 `alertNameOf`），本檔只負責把這個字串原樣帶進每一輪的設定。
  // 前後空白在這裡就修掉 —— 編輯器裡貼 label 名稱很容易帶到空白，而一個帶空白的
  // label 名永遠比對不中任何 label，症狀是「填了卻完全沒反應」（退回 alertname）。
  const alertNameLabel = (options.alertNameLabel ?? '').trim();
  // 值班靜音時段（#63）。**判斷不在這裡** —— 時段的解析與「現在算不算時段內」都在導播裡
  // （`parseQuietHours` / `isQuietAt`，以注入的時鐘判斷），本檔只負責把這兩個選項原樣帶進
  // 每一輪的設定。放進 effect 裡自己算的話，同一條交付閘門就會有兩個住處：
  // 每瀏覽器靜音（ADR-007）已經是導播的 `muted()`，排程靜音再留在元件就必然漂開。
  // 相依陣列刻意不含這兩個（理由同 `repeatFiringMin`，見下方 effect）。
  const quietHours = options.quietHours ?? '';
  const quietAllowCritical = options.quietAllowCritical ?? false;
  // 抖動抑制（#64）。同樣是**純接線**：翻轉次數、窗長的解析與「現在算不算抖動」
  // 全在導播裡（`parseFlapping`／`createFlappingTracker`，以注入的時鐘），本檔只把這兩個
  // 選項原樣帶進每一輪的設定。計數狀態必須跨輪累積，放在元件裡就得自己管一份 ref ——
  // 那正是 #58 把管線搬進導播時要除掉的東西。相依陣列刻意不含這兩個（理由同 `repeatFiringMin`）。
  // 兩個鍵缺席時都取「關閉」那一側（門檻 0、窗長 0 都等於關閉）：Grafana 會替缺席的鍵補上
  // `module.ts` 註冊的預設值（0 與 10），所以真的缺鍵只會發生在手改過的 dashboard JSON 上，
  // 而那時候寧可什麼都不抑制 —— 抑制會讓告警不出聲，那是比「多念一句」嚴重得多的失敗。
  const flappingThreshold = options.flappingThreshold ?? 0;
  const flappingWindowMin = options.flappingWindowMin ?? 0;
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

  // ---- 語音開關（ADR-007）----
  //
  // 狀態、同頁／跨分頁同步與補念觸發全在 `useVoiceSwitch`（#83）；補念佇列的三條行為
  // （窗內、同名只留最後一則、取出後清空）在不 import React 的 `speech/blockedQueue.ts`。
  // 本檔這一側只剩三個接線函式 —— 它們全都只碰 ref 與 setState，所以 `useCallback([])`
  // 是**真的**穩定，靜音的訂閱因此只掛一次。
  //
  // ⚠️ 宣告位置在 `speakingRef` 之後、avatar mount effect 之前：`silenceAvatar` 會寫
  // `speakingRef`，而 hook 自己那個 effect 只訂閱事件、不碰 avatar，排在哪都一樣。
  const currentSpeaker = useCallback(() => speakerRef.current, []);
  /** 切到靜音時的收尾（播報器自己的 stop() 由 hook 呼叫）。 */
  const silenceAvatar = useCallback(() => {
    flapRef.current?.stop();
    avatarRef.current?.setMouthOpen?.(0);
    avatarRef.current?.setSpeaking(false);
    speakingRef.current = false;
    setSpeaking(false);
  }, []);
  const clearSpeechErr = useCallback(() => setSpeechErr(null), []);
  const {
    muted,
    blocked: voiceBlocked,
    isMuted,
    recordBlocked,
    noteVoiceName,
    toggle: toggleVoice,
  } = useVoiceSwitch({
    speaker: currentSpeaker,
    voiceName,
    speechErr,
    onSilenced: silenceAvatar,
    onPending: setPending,
    onReplay: clearSpeechErr,
  });

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
  const directorFor = useCallback(
    (panelId: number): BroadcastDirector => {
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
        muted: isMuted,
      });
      directorRef.current = next;
      directorPanelRef.current = panelId;
      return next;
    },
    [isMuted]
  );

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
        // 標籤一旦不再是「被擋」，hook 會把「已確認」清掉 —— 之後再被擋會再提示（N1）。
        noteVoiceName(name);
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
        // 試聽句不收（那不是告警，F7 以**物件身分**判斷）。窗內過濾與同名去重在 blockedQueue。
        if (e === 'not-allowed' && plan && !PREVIEW_PLANS.has(plan)) {
          recordBlocked(plan);
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
  }, [enableTTS, ttsVoice, alertLang, ttsPitch, ttsRate, ttsEndpoint, ttsTimeoutSec, noteVoiceName, recordBlocked]);

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
    // `fallbackSeverity`、#63 的 `quietHours`／`quietAllowCritical`、
    // #64 的 `flappingThreshold`／`flappingWindowMin` 與 #69 的 `alertNameLabel`
    // （下方 eslint-disable 指的就是這七個）—— 它們只在這個
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
      alertNameLabel,
      alertLang,
      speakValue,
      severityAliasSpec,
      quietHours,
      quietAllowCritical,
      flappingThreshold,
      flappingWindowMin,
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
          // 「這一則為什麼沒念」原樣轉手（#81）。導播已經算好了（#63 的靜音時段、#64 的抖動抑制），
          // 這裡**不重算**：重算就等於同一條交付閘門有兩個住處，而元件這一側看不到翻轉次數。
          suppressed: item.suppressed,
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
          alertNameLabel,
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
    // 下面的 eslint-disable 指的是 `alertNameLabel`（#70）。它刻意**不**進相依陣列，
    // 理由與導播 effect 那五個同一條，而且這裡還多一層：紀錄端與播報端讀這個選項的
    // 時機必須一致。放進來的話，在編輯面板改這一欄會讓紀錄立刻換名、而本分頁已念過的
    // 句子還是舊名 —— 下一輪 refresh 之前，sessionOnly 的合併（比對句子）就會把同一則
    // 列兩次，也就是 #70 AC-5 要擋的那件事。兩邊都只在 `data` 刷新時讀，換名於是同進同退；
    // 代價是改了要等下一輪 refresh 生效（與 #69 在 README 與編輯器說明裡寫的那句一致）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, id, minSeverity, alertLang, speakValue, severityAliasSpec]);

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

  // 顯示哪幾列（合併、篩選、空清單判斷）全在 `buildFeedRows`（#79）——這裡只把結果映射成 JSX。
  // 紀錄模式顯示告警歷史（ADR-006）；讀不到時退回本分頁念過的句子（決策 7）。
  // ⚠️ 一輪 render **只算一次**，清單與匯出鈕讀的是**同一份** `feedRows` —— #80 AC-1 的
  // 「匯出的就是目前畫面上那幾列」因此不靠兩處各算一次來維持一致（篩選框一改，兩邊同時變）。
  const { rows: feedRows, emptyText: feedEmptyText } = buildFeedRows(feed, history, historyFilter);

  /**
   * 別名設定寫錯時的那一行提示（#81）。**只在編輯模式下算、也只在編輯模式下顯示** ——
   * 牆面螢幕是給值班的人看告警的，一行設定錯誤的提示在那裡只是干擾（AC-2）。
   *
   * ⚠️ 判定來源是 `data.request?.app`（`CoreApp.PanelEditor`），而 `data.request`
   * **在真實部署裡會缺**（12.3.x 的 dashboard uid 那次就是同一個欄位，見上面兩處註解）。
   * 缺席時 `isPanelEditor` 回 false → 提示不顯示 → 退化成「編輯者少看到一行提示」，
   * 而不是「值班牆上多一行」。這個取捨與它的驗證界線寫在 `src/README.md` 與 PR 描述裡。
   *
   * 解析放在這裡而不是上面那些 `options.*` 旁邊：`parseSeverityAliases` 的結果是物件，
   * 擺在 render 的頂層會讓人想把它塞進某個相依陣列 —— 那正是 `severityAliasSpec` 那段
   * 註解在擋的事。這裡只有**編輯模式**下才跑一次幾個 split，與任何 effect 無關。
   */
  const aliasNotice = isPanelEditor(data.request?.app)
    ? skippedAliasNotice(parseSeverityAliases(severityAliasSpec).skipped, alertLang)
    : null;

  const renderFeedLines = () => {
    if (feedEmptyText !== null) {
      return <span className={styles.empty}>{feedEmptyText}</span>;
    }
    // data-origin 讓探測與測試分得出「紀錄列」與「本分頁念過的列」（複審 H1）。
    // data-suppressed 的**值就是原因字串**（`'flapping'`／`'quiet'`，#81）而不是 `'true'`：
    // 測試要分辨兩種標記時不必比中文字面值，語言一改也不會碎。沒有 `suppressed` 的列
    // 傳進去的是 `undefined`，React 於是整個屬性都不渲染 —— 那一列的畫面逐字如舊（AC-1）。
    return feedRows.map((r) => {
      const mark = r.suppressed === undefined ? null : suppressedMark(r.suppressed, alertLang);
      return (
        <div key={r.key} className={styles.line} data-origin={r.origin} data-suppressed={r.suppressed}>
          <span className={styles.when}>{r.when}</span>
          {mark && (
            <span className={styles.suppressedMark} title={mark.title}>
              {mark.label}
            </span>
          )}
          <span>{r.text}</span>
        </div>
      );
    });
  };

  /** 匯出：目前畫面上那幾列 → CSV → 下載（#80；內容與檔名都在 `exportFeedRowsAsCsv` 底下那兩支）。 */
  const exportFeedCsv = () => {
    const alertState = (data as unknown as { alertState?: AlertStateLike }).alertState;
    // dashboard uid 的取法與導播、紀錄兩個 effect 同一套（12.3.x 的 alertState 沒有 dashboardUID）；
    // 兩個來源都取不到時檔名會省略那一段，不會長出 `undefined`（見 `feedCsvFilename`）。
    exportFeedRowsAsCsv(feedRows, alertState?.dashboardUID ?? data.request?.dashboardUID, id);
  };

  const chipColor = theme.visualization.getColorByName(
    ({ calm: 'blue', warning: 'orange', critical: 'red', resolved: 'green' } as const)[emotion]
  );
  // SP-7.16：機械驗收只涵蓋內建的兩張 sheet。使用者自己填的圖要在畫面上標明。
  const customSprite = useSprite && (directionsImgUrl.trim() !== '' || reactionsImgUrl.trim() !== '');
  // 「啟用語音」鈕的門檻與 stage 的門檻各自獨立、不共用（SP-1.8 末段明文）。
  const roomy = width >= 320 && height >= 180;
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
            onClick={() => toggleVoice()}
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
        {/*
          匯出鈕（#80）。門檻與語音那兩顆同一個 `roomy`（>=320x180）：窄面板改成上下堆疊、
          更窄還會退到 DiagnosticAvatar，多一顆按鈕在那個寬度只會把 head 擠成好幾列。
          與語音鈕不同的是它**不看 `enableTTS`** —— 關掉語音時清單照樣在長，紀錄也照樣要帶得走。
        */}
        {roomy && (
          <button
            className={styles.btn}
            onClick={exportFeedCsv}
            type="button"
            disabled={feedRows.length === 0}
            data-testid="feed-export"
            title={
              feedRows.length === 0
                ? '清單上目前沒有任何一列，沒有東西可以匯出'
                : '把清單上目前這幾列（套用篩選之後）下載成 CSV；時間是 UTC 的 ISO 8601'
            }
          >
            匯出 CSV
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
          {/*
            編輯模式下才出現的那一行（#81 AC-2）。排在篩選框之前：它講的是**設定**寫錯了，
            與這段時間範圍內有哪些紀錄無關，而打開編輯面板的人要先看到自己剛打錯的那一行。
          */}
          {aliasNotice !== null && (
            <span className={styles.notice} style={{ color: theme.colors.warning.text }} data-testid="alias-notice">
              {aliasNotice}
            </span>
          )}
          {history && (
            <input
              className={styles.filter}
              value={historyFilter}
              onChange={(e) => setHistoryFilter(e.currentTarget.value)}
              placeholder="篩選紀錄（規則名、內容、主機、pod…）"
              aria-label="篩選播報紀錄"
            />
          )}
          {historyError && <span className={styles.notice}>讀不到告警歷史：{historyError}。只顯示本分頁的播報。</span>}
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

/**
 * 匯出一次：目前畫面上那幾列 → CSV → 下載（#80）。
 *
 * **放在元件外面**是刻意的：它要讀「現在」（檔名的時間戳），而「現在」只有在按下去的那一刻
 * 才該被讀 —— 寫在 render 裡的話那是個會讓 render 不純的呼叫（react-hooks 的 purity 規則也會擋）。
 * 這一支自己不決定任何格式：CSV 的內容與檔名在 `src/feed/feedCsv.ts`（純函式、有自己的單元測試），
 * DOM 的部分在下面那一支。
 *
 * 零列時直接回頭不下載空檔（#80 AC-4）。畫面上按不到這條路：清單是空的時候按鈕是 disabled；
 * 這道早退是第二層，免得日後有人把 `disabled` 拿掉就靜默下載一份只有標題列的檔案。
 */
function exportFeedRowsAsCsv(rows: readonly FeedRow[], dashboardUid: string | undefined, panelId: number): void {
  if (rows.length === 0) {
    return;
  }
  downloadTextFile(feedRowsToCsv(rows), feedCsvFilename({ dashboardUid, panelId, at: Date.now() }), FEED_CSV_MIME);
}

/**
 * 把一段文字當檔案下載下來（匯出 CSV 的唯一一處 DOM 動作，#80）。
 *
 * **刻意與 `feedRowsToCsv` 分開**（AC-3）：「CSV 長什麼樣」是純函式的事、有自己的單元測試；
 * 這裡只有 Blob + `a[download]`。零後端（ADR-004）—— 檔案在瀏覽器裡生出來，沒有任何網路請求，
 * `createObjectURL` 的 `blob:` URL 也不會離開這個分頁。
 */
function downloadTextFile(text: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  // Firefox 要求這個 a 在 document 裡才會觸發下載；`display:none` ＋ 立刻移走，畫面上看不到它。
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 在部分瀏覽器會把還沒開始的下載取消掉，所以排到下一個 task 再回收 ——
  // 不回收的話這個 blob 會活到分頁關掉為止（匯出鈕是可以連按的）。
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
