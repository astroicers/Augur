/**
 * `MascotPanel` 的接線測試。
 *
 * **為什麼現在才補**：P2 當初拒補的理由逐字是「production 端對 `src/core/` 目前零 import，
 * 此刻自己接線自己斷言，P4 把次序寫反時照樣會綠」。**P4 的串接碼現在存在了**，
 * 那個理由不成立 —— 而這支檔案是整條導播管線唯一的匯流處
 * （過濾 → 防洪 → 組句 → 播報全在同一個 effect 裡）。
 *
 * **只 mock 兩個邊界**：`fetchPanelRules`（網路）與 `createSpeaker`（瀏覽器語音）。
 * `panelAlerts` / `dedup` / `severity` / `format` 全部跑真的 —— mock 掉它們就等於
 * 又回到「自己接線自己斷言」。
 */

import React from 'react';
import { render, act, waitFor } from '@testing-library/react';
import { LoadingState, PanelProps } from '@grafana/data';

import { MascotPanel } from '../MascotPanel';
import type { MascotPanelOptions } from '../../panelOptions';
import type { BroadcastPlan } from '../../core/types';
import type { SpeakerEvents } from '../../speech/speaker';
import { fetchPanelRules } from '../../sources/rulesFetcher';
import { DiagnosticAvatar } from '../../avatar/DiagnosticAvatar';

jest.mock('../../sources/rulesFetcher', () => ({
  RULES_ENDPOINT: '/api/prometheus/grafana/api/v1/rules',
  fetchPanelRules: jest.fn(),
}));

/** createSpeaker 的攔截器：記下 enqueue 進來的 plan，並把 events 留給測試觸發。 */
const spoken: BroadcastPlan[] = [];
let capturedEvents: SpeakerEvents | undefined;

jest.mock('../../speech/speaker', () => ({
  ...jest.requireActual('../../speech/speaker'),
  createSpeaker: jest.fn((_synth: unknown, opts: { events?: SpeakerEvents }) => {
    capturedEvents = opts?.events;
    return {
      enqueue: (plan: BroadcastPlan) => spoken.push(plan),
      pending: () => 0,
      unlock: () => {},
      dispose: () => {},
    };
  }),
}));

const mockedFetch = fetchPanelRules as unknown as jest.Mock;

const OPTIONS: MascotPanelOptions = {
  minSeverity: 'warning',
  repeatFiringMin: 0,
  fallbackSeverity: 'critical',
  alertLang: 'zh',
  enableTTS: true,
  ttsVoice: '',
};

function props(over: {
  state?: LoadingState;
  alertState?: unknown;
  options?: Partial<MascotPanelOptions>;
}): PanelProps<MascotPanelOptions> {
  return {
    id: 7,
    width: 600,
    height: 400,
    options: { ...OPTIONS, ...over.options },
    data: {
      state: over.state ?? LoadingState.Done,
      series: [],
      timeRange: {},
      ...(over.alertState === undefined ? {} : { alertState: over.alertState }),
    },
  } as unknown as PanelProps<MascotPanelOptions>;
}

const ALERTING = { state: 'alerting', panelId: 7, dashboardUID: 'dash-1' };
const PENDING = { state: 'pending', panelId: 7, dashboardUID: 'dash-1' };
const OK = { state: 'ok', panelId: 7, dashboardUID: 'dash-1' };

beforeEach(() => {
  spoken.length = 0;
  capturedEvents = undefined;
  mockedFetch.mockReset();
  // speaker effect 的守門是 `!window.speechSynthesis`，mock 掉 createSpeaker 也繞不過它。
  Object.defineProperty(window, 'speechSynthesis', { value: {}, configurable: true });
});

/** 等導播 effect 的 async 鏈跑完。 */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

test('(a) data.state !== Done 時完全不評估 —— 空 series 會被讀成「全部恢復」', async () => {
  mockedFetch.mockResolvedValue([{ alertname: 'CPU', severity: 'critical' }]);
  render(<MascotPanel {...props({ state: LoadingState.Loading, alertState: ALERTING })} />);
  await settle();

  // 這條守門擋的是 pull 模型最容易踩的誤報：載入中 data.series 是空的，
  // 在 threshold 路徑上會被讀成「全部回到 base step」→ 對每個 episode 送 resolved
  // → 資料庫連不上竟然播「告警已恢復」。
  expect(mockedFetch).not.toHaveBeenCalled();
  expect(spoken).toHaveLength(0);
});

test('(b) 次序是 過濾 → 防洪 → 組句，且 resolved 不受 minSeverity 門檻影響', async () => {
  mockedFetch.mockResolvedValue([
    { alertname: 'DiskWarn', severity: 'warning', summary: '磁碟快滿', value: 91 },
    { alertname: 'Chatter', severity: 'info', summary: '有點吵' },
  ]);

  const view = render(<MascotPanel {...props({ alertState: ALERTING })} />);
  await waitFor(() => expect(spoken.length).toBeGreaterThan(0));

  // 過濾：minSeverity = warning，info 那則不該進來
  expect(spoken.map((p) => p.text).join(' ')).toContain('磁碟');
  expect(spoken.map((p) => p.text).join(' ')).not.toContain('有點吵');
  // 組句在最後：拿到的是 BroadcastPlan 不是 ParsedAlert
  expect(spoken[0]).toHaveProperty('emotion');
  expect(spoken[0]!.emotion).toBe('warning');
  const afterFirst = spoken.length;

  // 防洪：同一個 alertState 再評估一次，repeatFiringMin = 0 → 永不重播
  view.rerender(<MascotPanel {...props({ alertState: { ...ALERTING } })} />);
  await settle();
  expect(spoken).toHaveLength(afterFirst);

  // resolved 不受門檻影響：把 minSeverity 調高到 critical 之後才恢復。
  // 那則 warning 已經播過 firing，就該播恢復 —— 這正是 `status === 'firing' &&`
  // 這個前綴存在的理由，拿掉它會讓「播了警告卻永遠不播恢復」。
  view.rerender(<MascotPanel {...props({ alertState: OK, options: { minSeverity: 'critical' } })} />);
  await waitFor(() => expect(spoken.length).toBeGreaterThan(afterFirst));
  expect(spoken[spoken.length - 1]!.emotion).toBe('resolved');
});

test('(c) onStart 用的是正在念的那一則的 emotion，不是 plans[0]', async () => {
  mockedFetch.mockResolvedValue([
    { alertname: 'A', severity: 'warning', summary: '先來的' },
    { alertname: 'B', severity: 'critical', summary: '後來的' },
  ]);
  const setEmotion = jest.spyOn(DiagnosticAvatar.prototype, 'setEmotion');

  render(<MascotPanel {...props({ alertState: ALERTING })} />);
  await waitFor(() => expect(spoken.length).toBe(2));
  setEmotion.mockClear();

  // 模擬佇列念到第二則。先前寫成 `onStart: () => {}` 把 plan 丟掉，
  // 結果一批三則時臉會定在 plans[0] 的情緒長達 42 秒（語速 5.6 字/秒、一則約 14 秒）。
  const second = spoken.find((p) => p.emotion === 'critical')!;
  act(() => {
    capturedEvents?.onStart?.(second);
  });
  expect(setEmotion).toHaveBeenCalledWith('critical');

  const first = spoken.find((p) => p.emotion === 'warning')!;
  act(() => {
    capturedEvents?.onStart?.(first);
  });
  expect(setEmotion).toHaveBeenLastCalledWith('warning');
  setEmotion.mockRestore();
});

// ---------------------------------------------------------------------------
// A1-2：pending 反應與觀測出口
// ---------------------------------------------------------------------------

test('pending：calm 且未播報時顯示，播報中不顯示，離開即清除', async () => {
  mockedFetch.mockResolvedValue([]);
  const setReaction = jest.spyOn(DiagnosticAvatar.prototype, 'setReaction');

  const view = render(<MascotPanel {...props({ alertState: PENDING })} />);
  await settle();
  // ⚠️ 這條**不得**繞經 panelAlerts.evaluate —— 它對 pending 回 [] 是正確行為，
  // pending 是表情不是播報。所以 fetchRules 一次都不該被呼叫。
  expect(mockedFetch).not.toHaveBeenCalled();
  expect(setReaction).toHaveBeenLastCalledWith('pending');

  // 播報中不顯示：情緒仍是 calm，變的只有 speaking —— 刻意用 calm 的 plan 隔離出這一個條件
  setReaction.mockClear();
  act(() => {
    capturedEvents?.onStart?.({ text: '測試', emotion: 'calm' } as BroadcastPlan);
  });
  expect(setReaction).toHaveBeenLastCalledWith(null);

  // 播完回來
  setReaction.mockClear();
  act(() => {
    capturedEvents?.onEnd?.({ text: '測試', emotion: 'calm' } as BroadcastPlan);
  });
  expect(setReaction).toHaveBeenLastCalledWith('pending');

  // 離開 pending 即清除
  setReaction.mockClear();
  view.rerender(<MascotPanel {...props({ alertState: OK })} />);
  await settle();
  expect(setReaction).toHaveBeenLastCalledWith(null);
  setReaction.mockRestore();
});

test('pending：依賴變了但顯示條件沒變時不碰 setReaction —— 否則會掃掉 click 反應', async () => {
  mockedFetch.mockResolvedValue([]);
  const setReaction = jest.spyOn(DiagnosticAvatar.prototype, 'setReaction');

  render(<MascotPanel {...props({ alertState: OK })} />);
  await settle();
  setReaction.mockClear();

  // ⚠️ 這條測試的第一版是「同樣的 alertState 再 rerender 三次」，**那沒有分辨力** ——
  // `rawAlertState` 還是同一個字串，effect 的依賴根本沒變，有沒有轉換守門都不會被呼叫。
  // 真正會出事的是「依賴變了、但顯示條件從頭到尾都是 false」：
  // 情緒與 speaking 都動了，而 pending 一直不該顯示。沒有守門的話這裡會吐一次
  // `setReaction(null)`，正好把使用者剛點下去、還在 420ms 內的 click 反應掃掉。
  act(() => {
    capturedEvents?.onStart?.({ text: 'x', emotion: 'critical' } as BroadcastPlan);
  });
  await settle();
  expect(setReaction).not.toHaveBeenCalled();
  setReaction.mockRestore();
});

test('觀測出口：chip 顯示 alertState.state 的原值', async () => {
  mockedFetch.mockResolvedValue([]);
  const view = render(<MascotPanel {...props({ alertState: PENDING })} />);
  await settle();
  expect(view.getByTestId('alert-state-chip').textContent).toContain('pending');

  view.rerender(<MascotPanel {...props({ alertState: OK })} />);
  await settle();
  expect(view.getByTestId('alert-state-chip').textContent).toContain('ok');

  // alertState 不存在時顯示 — 而不是消失。它是黏著的、永不回 undefined，
  // 所以「看到 —」本身就是「這個 dashboard 的四個前置條件沒滿足」的訊號。
  view.rerender(<MascotPanel {...props({})} />);
  await settle();
  expect(view.getByTestId('alert-state-chip').textContent).toContain('—');
});

test('click 結束後若 pending 仍成立，必須回到 pending 而不是 null', async () => {
  mockedFetch.mockResolvedValue([]);
  jest.useFakeTimers();
  const setReaction = jest.spyOn(DiagnosticAvatar.prototype, 'setReaction');
  try {
    const view = render(<MascotPanel {...props({ alertState: PENDING })} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(setReaction).toHaveBeenLastCalledWith('pending');

    // 點一下 panel。在 jsdom 裡看不到其他 panel，所以走的是降級路徑 —— 一樣會觸發 click 回饋。
    setReaction.mockClear();
    const host = view.getByTestId('mascot-stage');
    await act(async () => {
      host.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    expect(setReaction).toHaveBeenLastCalledWith('click');

    // ⚠️ 420ms 後**必須回到 pending**，不是 null。
    // 先前 click 的計時器無條件送 setReaction(null)，而 pending 那邊的守門旗標
    // 還記著「已顯示」，依賴不變就不會再送一次 —— pending 從此永久消失。
    setReaction.mockClear();
    await act(async () => {
      jest.advanceTimersByTime(500);
    });
    expect(setReaction).toHaveBeenLastCalledWith('pending');
  } finally {
    setReaction.mockRestore();
    jest.useRealTimers();
  }
});

test('StrictMode 重複 mount 時，真正在畫面上的那個 avatar 收得到 pending', async () => {
  mockedFetch.mockResolvedValue([]);
  const setReaction = jest.spyOn(DiagnosticAvatar.prototype, 'setReaction');
  const disposed: DiagnosticAvatar[] = [];
  const origDispose = DiagnosticAvatar.prototype.dispose;
  jest.spyOn(DiagnosticAvatar.prototype, 'dispose').mockImplementation(function (this: DiagnosticAvatar) {
    disposed.push(this);
    return origDispose.call(this);
  });
  try {
    render(
      <React.StrictMode>
        <MascotPanel {...props({ alertState: PENDING })} />
      </React.StrictMode>
    );
    await act(async () => {
      await Promise.resolve();
    });
    // StrictMode 下第一個 avatar 會被 dispose。收到 'pending' 的那一次，
    // 呼叫者不得是已經 dispose 掉的那一個 —— 先前守門旗標不隨 cleanup 重置，
    // 於是第二個（真正在畫面上的）永遠停在 null。
    const pendingCalls = setReaction.mock.contexts.filter((_, i) => setReaction.mock.calls[i]![0] === 'pending');
    expect(pendingCalls.length).toBeGreaterThan(0);
    const live = pendingCalls.filter((c) => !disposed.includes(c as DiagnosticAvatar));
    expect(live.length).toBeGreaterThan(0);
  } finally {
    jest.restoreAllMocks();
  }
});

/**
 * 迴歸：一次來多則時，**播報順序必須是時間順序**，而 feed 是新的在上。
 *
 * ⚠️ 原本寫的是 `setFeed((prev) => [...plans.reverse(), ...prev])` ——
 * `reverse()` 就地改動陣列，而它後面兩處都讀同一個 `plans`：
 *   1. `setEmotion(plans[0])` 拿到的是**最後**一則的情緒而不是第一則；
 *   2. `sp.enqueue()` 的迴圈照**反序**播報。
 * 而且它在 setState 的 updater 裡，StrictMode 的雙呼叫會反轉兩次而抵銷 ——
 * 開發模式與正式模式的 feed 順序不一樣，是最難查的那種。
 */
test('一次來多則時播報照時間順序，且 feed 是新的在上', async () => {
  mockedFetch.mockResolvedValue([
    { alertname: 'First', severity: 'critical', summary: '第一則', value: 1 },
    { alertname: 'Second', severity: 'warning', summary: '第二則', value: 2 },
  ]);

  const view = render(<MascotPanel {...props({ alertState: ALERTING })} />);
  await waitFor(() => expect(spoken.length).toBeGreaterThanOrEqual(2));

  // 播報照來的順序，不是反序
  const texts = spoken.map((p) => p.text);
  const iFirst = texts.findIndex((t) => t.includes('第一則'));
  const iSecond = texts.findIndex((t) => t.includes('第二則'));
  expect(iFirst).toBeGreaterThanOrEqual(0);
  expect(iSecond).toBeGreaterThanOrEqual(0);
  expect(iFirst).toBeLessThan(iSecond);

  // feed 是新的在上 —— 最後一則排在最前
  const feedText = view.container.textContent ?? '';
  expect(feedText).toContain('第一則');
  expect(feedText).toContain('第二則');
  expect(feedText.indexOf('第二則')).toBeLessThan(feedText.indexOf('第一則'));
});

/**
 * 同一件事的 StrictMode 面。
 *
 * ⚠️ 上一條測不到 `plans.reverse()` 的就地改動 —— `setFeed` 的 updater 是**惰性**的，
 * React 可能在後續 render 才執行它，那時 enqueue 早就跑完了，於是播報順序「碰巧」是對的。
 * 真正看得見差異的是 StrictMode：updater 被呼叫兩次 → 反轉兩次 → 抵銷，
 * feed 變成舊的在上，而正式模式是新的在上。**開發與正式行為不一致**，最難查的那種。
 */
test('StrictMode 下 feed 順序必須與正式模式相同（updater 不得就地改動）', async () => {
  mockedFetch.mockResolvedValue([
    { alertname: 'First', severity: 'critical', summary: '第一則', value: 1 },
    { alertname: 'Second', severity: 'warning', summary: '第二則', value: 2 },
  ]);

  const view = render(
    <React.StrictMode>
      <MascotPanel {...props({ alertState: ALERTING })} />
    </React.StrictMode>
  );
  await waitFor(() => expect(view.container.textContent ?? '').toContain('第二則'));

  const feedText = view.container.textContent ?? '';
  expect(feedText.indexOf('第二則')).toBeLessThan(feedText.indexOf('第一則'));
});
