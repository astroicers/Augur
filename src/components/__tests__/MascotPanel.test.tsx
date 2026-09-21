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
