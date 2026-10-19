/**
 * #83 AC-2／AC-3：`useVoiceSwitch` 的狀態、同步與補念觸發。
 *
 * **ADR-007 的三項決策在這一層都不是靠替身過關**（票上留言 (d) 提的那個接縫）：
 *
 * - 決策 1（每瀏覽器靜音）走的是**真的** `src/speech/muteStore.ts` 與 jsdom 的
 *   `localStorage` —— 本檔**沒有** `jest.mock('../../speech/muteStore')`，
 *   斷言直接讀 `window.localStorage.getItem(MUTE_STORAGE_KEY)`。
 * - 決策 2／3（10 分鐘內補念、同一則只補最後狀態）走的是**真的**
 *   `src/speech/blockedQueue.ts`；窗長邊界由那一支的單元測試以注入時鐘釘住（AC-1），
 *   這裡驗的是「hook 真的把它接上去了」。
 *
 * 唯一的替身是播報器（`Speaker`）—— 它是瀏覽器語音引擎的邊界，jsdom 裡本來就沒有。
 */
import React, { useEffect } from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { render, act, fireEvent } from '@testing-library/react';

import { useVoiceSwitch, voiceBlockedBy, AUTOPLAY_BLOCKED, type VoiceSwitch } from '../useVoiceSwitch';
import { MUTE_EVENT, MUTE_STORAGE_KEY } from '../../speech/muteStore';
import type { BroadcastPlan } from '../../core/types';
import type { Speaker } from '../../speech/speaker';

/** 被擋下的那一則。 */
function plan(name: string, text: string, status: 'firing' | 'resolved' = 'firing'): BroadcastPlan {
  return { text, severity: 'critical', emotion: status === 'firing' ? 'critical' : 'resolved', name, status };
}

/** 播報器替身：記下 unlock／stop／enqueue，`pending()` 由測試擺布。 */
function fakeSpeaker() {
  const calls = { unlock: 0, stop: 0 };
  const enqueued: BroadcastPlan[] = [];
  let pendingCount = 0;
  const speaker: Speaker = {
    unlock: () => {
      calls.unlock++;
    },
    enqueue: (p) => {
      enqueued.push(p);
    },
    pending: () => pendingCount,
    isSpeaking: () => false,
    stop: () => {
      calls.stop++;
    },
    voiceName: () => null,
    dispose: () => {},
  };
  return {
    speaker,
    calls,
    enqueued,
    setPending(n: number) {
      pendingCount = n;
    },
  };
}

/** 元件那一側的收尾呼叫。 */
interface HostCalls {
  silenced: number;
  pending: number[];
  replay: number;
}

interface ProbeProps {
  speaker: () => Speaker | null;
  voiceName: string | null;
  speechErr: string | null;
  onSilenced: () => void;
  onPending: (pending: number) => void;
  onReplay: () => void;
  /** 每次 render 之後把 hook 的回傳值交給測試（在 effect 裡送，不在 render 期間）。 */
  onReady: (sw: VoiceSwitch) => void;
}

/**
 * 把 hook 掛進一個最小的元件。`latest` 讓測試在 `act()` 裡直接呼叫
 * `recordBlocked`／`noteVoiceName` —— 它們在真的面板裡是由播報器的回呼觸發的。
 */
let latest: VoiceSwitch | null = null;

function Probe(props: ProbeProps) {
  const { speaker, voiceName, speechErr, onSilenced, onPending, onReplay, onReady } = props;
  const sw = useVoiceSwitch({ speaker, voiceName, speechErr, onSilenced, onPending, onReplay });
  useEffect(() => {
    onReady(sw);
  });
  return (
    <button data-testid="toggle" onClick={() => sw.toggle()}>
      {sw.muted ? 'muted' : sw.blocked ? 'blocked' : 'on'}
    </button>
  );
}

/** 一組（替身播報器 + 收尾計數 + render 結果）。收尾函式建在元件外面，所以天生穩定。 */
function mount(over: { voiceName?: string | null; speechErr?: string | null } = {}) {
  const sp = fakeSpeaker();
  const calls: HostCalls = { silenced: 0, pending: [], replay: 0 };
  const wiring = {
    speaker: () => sp.speaker,
    onSilenced: () => {
      calls.silenced++;
    },
    onPending: (n: number) => {
      calls.pending.push(n);
    },
    onReplay: () => {
      calls.replay++;
    },
    onReady: (sw: VoiceSwitch) => {
      latest = sw;
    },
  };
  const view = render(<Probe {...wiring} voiceName={over.voiceName ?? null} speechErr={over.speechErr ?? null} />);
  const rerender = (next: { voiceName?: string | null; speechErr?: string | null }) =>
    view.rerender(<Probe {...wiring} voiceName={next.voiceName ?? null} speechErr={next.speechErr ?? null} />);
  return { sp, calls, view, rerender, btn: () => view.getByTestId('toggle') };
}

beforeEach(() => {
  latest = null;
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------
// ADR-007 決策 1：每瀏覽器靜音（真的 muteStore + 真的 localStorage）
// ---------------------------------------------------------------------------

describe('#83 AC-3：ADR-007 決策 1 —— 每瀏覽器靜音（不經替身，走真的 muteStore）', () => {
  test('初始值讀本機：存著 "1" 時掛載起來就是靜音', () => {
    window.localStorage.setItem(MUTE_STORAGE_KEY, '1');
    const { btn } = mount();
    expect(btn().textContent).toBe('muted');
    expect(latest!.isMuted()).toBe(true);
  });

  test('沒存過就是語音開', () => {
    const { btn } = mount();
    expect(btn().textContent).toBe('on');
    expect(latest!.isMuted()).toBe(false);
  });

  test('按下開關把靜音寫進真的 localStorage（之後重新掛載讀得回來）', () => {
    const first = mount();
    fireEvent.click(first.btn());
    expect(first.btn().textContent).toBe('muted');
    expect(window.localStorage.getItem(MUTE_STORAGE_KEY)).toBe('1');

    first.view.unmount();
    const second = mount();
    expect(second.btn().textContent).toBe('muted');
  });

  test('再按一下寫回 "0"，而且叫醒語音引擎', () => {
    window.localStorage.setItem(MUTE_STORAGE_KEY, '1');
    const { btn, sp } = mount();
    fireEvent.click(btn());
    expect(btn().textContent).toBe('on');
    expect(window.localStorage.getItem(MUTE_STORAGE_KEY)).toBe('0');
    expect(sp.calls.unlock).toBe(1);
  });

  test('`isMuted()` 在同一個 tick 裡就是新值 —— 導播讀的是它，不能等 React 重繪', () => {
    const { btn } = mount();
    act(() => {
      btn().click();
      // 還沒離開這個事件，React 也還沒重繪
      expect(latest!.isMuted()).toBe(true);
    });
  });

  test('切到靜音：停掉播報器、收尾元件那一側、回報佇列長度', () => {
    const { btn, sp, calls } = mount();
    sp.setPending(3);
    fireEvent.click(btn());
    expect(sp.calls.stop).toBe(1);
    expect(calls.silenced).toBe(1);
    expect(calls.pending).toEqual([3]);
  });

  test('同一頁另一個 panel 按了開關：本 hook 跟著同步（MUTE_EVENT，真的事件）', () => {
    const { btn } = mount();
    act(() => {
      window.dispatchEvent(new CustomEvent<boolean>(MUTE_EVENT, { detail: true }));
    });
    expect(btn().textContent).toBe('muted');
  });

  test('另一個分頁改了本機儲存：storage 事件也跟著同步', () => {
    const { btn } = mount();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: MUTE_STORAGE_KEY, newValue: '1' }));
    });
    expect(btn().textContent).toBe('muted');
  });

  test('別人的鍵不會把吉祥物靜音（過濾條件在 muteStore，這裡驗接線）', () => {
    const { btn } = mount();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'someone.else', newValue: '1' }));
    });
    expect(btn().textContent).toBe('on');
  });

  test('卸載後同頁事件不再走進 applyMuted —— 播報器沒被停、元件那一側沒被收尾（訂閱有解除）', () => {
    const { view, sp, calls } = mount();
    view.unmount();
    act(() => {
      window.dispatchEvent(new CustomEvent<boolean>(MUTE_EVENT, { detail: true }));
    });
    // ⚠️ 不能只斷言「不拋」：React 18 對卸載後的 setState 是**靜默** no-op，
    // 所以訂閱漏掉沒解除時那一形照樣不拋（實測：拿掉 useEffect 的 cleanup，0 支轉紅）。
    // 驗得到的是 applyMuted 的**副作用**有沒有發生 —— 那幾支是注入進來的，卸載後也還活著。
    expect(sp.calls.stop).toBe(0);
    expect(calls.silenced).toBe(0);
    expect(calls.pending).toEqual([]);
  });

  test('本機儲存讀寫丟例外時照樣能用（預設語音開，切換仍生效）', () => {
    const get = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const { btn } = mount();
      expect(btn().textContent).toBe('on');
      fireEvent.click(btn());
      expect(btn().textContent).toBe('muted');
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// ADR-007 決策 2／3：補念（走真的 blockedQueue）
// ---------------------------------------------------------------------------

describe('#83 AC-3：ADR-007 決策 2／3 —— 按一下補念（走真的 blockedQueue）', () => {
  test('被擋下的句子在按下開關時補念，且狀態維持「開」（不變成靜音）', () => {
    const { btn, sp } = mount({ speechErr: 'not-allowed' });
    const p = plan('A', '偵測到告警：A。');
    act(() => latest!.recordBlocked(p));
    expect(btn().textContent).toBe('blocked');

    fireEvent.click(btn());
    expect(sp.enqueued).toEqual([p]);
    expect(sp.calls.unlock).toBe(1);
    expect(latest!.isMuted()).toBe(false);
    expect(window.localStorage.getItem(MUTE_STORAGE_KEY)).not.toBe('1');
  });

  test('同一則告警只補最後的狀態：被擋時已恢復的只念恢復句（決策 3）', () => {
    const { btn, sp } = mount({ speechErr: 'not-allowed' });
    act(() => {
      latest!.recordBlocked(plan('A', '偵測到告警：A。'));
      latest!.recordBlocked(plan('B', '偵測到告警：B。'));
      latest!.recordBlocked(plan('A', '告警已恢復：A。', 'resolved'));
    });
    fireEvent.click(btn());
    expect(sp.enqueued.map((p) => p.text)).toEqual(['偵測到告警：B。', '告警已恢復：A。']);
  });

  test('超過 10 分鐘的被擋句不補念（決策 2 的時限真的接上去了）', () => {
    const realNow = Date.now;
    let now = 1_000_000_000_000;
    Date.now = () => now;
    try {
      const { btn, sp } = mount({ speechErr: 'not-allowed' });
      act(() => latest!.recordBlocked(plan('Old', '偵測到告警：Old。')));
      now += 11 * 60 * 1000;
      act(() => latest!.recordBlocked(plan('New', '偵測到告警：New。')));
      fireEvent.click(btn());
      expect(sp.enqueued.map((p) => p.text)).toEqual(['偵測到告警：New。']);
    } finally {
      Date.now = realNow;
    }
  });

  test('補念之前先清掉錯誤訊息，之後回報佇列長度（順序是「清 → 補 → 回報」）', () => {
    const { btn, sp, calls } = mount({ speechErr: 'not-allowed' });
    act(() => latest!.recordBlocked(plan('A', '偵測到告警：A。')));
    sp.setPending(1);
    fireEvent.click(btn());
    expect(calls.replay).toBe(1);
    expect(calls.pending).toEqual([1]);
  });

  test('取出後清空：再按一下不會把同一則念第二次', () => {
    const { btn, sp } = mount({ speechErr: 'not-allowed' });
    act(() => latest!.recordBlocked(plan('A', '偵測到告警：A。')));
    fireEvent.click(btn());
    expect(sp.enqueued).toHaveLength(1);
    // 仍是「被擋」狀態（speechErr 還在），再按一下
    fireEvent.click(btn());
    expect(sp.enqueued).toHaveLength(1);
  });

  test('切到靜音會清空補念佇列 —— 解除靜音後再被擋，不會冒出靜音前那幾則', () => {
    const { btn, sp, rerender } = mount({ speechErr: null });
    act(() => latest!.recordBlocked(plan('A', '靜音前被擋的')));
    fireEvent.click(btn()); // 靜音
    expect(btn().textContent).toBe('muted');
    fireEvent.click(btn()); // 解除靜音
    rerender({ speechErr: 'not-allowed' });
    expect(btn().textContent).toBe('blocked');
    fireEvent.click(btn());
    expect(sp.enqueued).toEqual([]);
  });

  test('沒有被擋過也按得下去（空佇列不炸、也不變靜音）', () => {
    const { btn, sp } = mount({ speechErr: 'not-allowed' });
    fireEvent.click(btn());
    expect(sp.enqueued).toEqual([]);
    expect(latest!.isMuted()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 「被擋」的判定（複審 F3／N1）
// ---------------------------------------------------------------------------

describe('#83：「開著但被擋」的判定', () => {
  test('外部語音被自動播放政策擋下（聲線標籤含 autoplay-blocked）也算被擋（F3）', () => {
    const { btn, sp } = mount({ voiceName: `引擎預設（外部語音失敗：${AUTOPLAY_BLOCKED}，已降級）` });
    expect(btn().textContent).toBe('blocked');
    fireEvent.click(btn());
    expect(sp.calls.unlock).toBe(1);
    expect(window.localStorage.getItem(MUTE_STORAGE_KEY)).not.toBe('1');
  });

  test('N1：按一下後變回「語音開」，再按一下才是靜音', () => {
    const { btn } = mount({ voiceName: `引擎預設（外部語音失敗：${AUTOPLAY_BLOCKED}，已降級）` });
    fireEvent.click(btn());
    expect(btn().textContent).toBe('on');
    fireEvent.click(btn());
    expect(btn().textContent).toBe('muted');
  });

  test('N1：外部語音恢復一次之後又被擋，要再提示（不被先前的「已確認」吃掉）', () => {
    const blockedLabel = `引擎預設（外部語音失敗：${AUTOPLAY_BLOCKED}，已降級）`;
    const { btn, rerender } = mount({ voiceName: blockedLabel });
    fireEvent.click(btn());
    expect(btn().textContent).toBe('on');

    act(() => latest!.noteVoiceName('外部語音（tts.local:8765）'));
    rerender({ voiceName: blockedLabel });
    expect(btn().textContent).toBe('blocked');
  });

  test('靜音中就不算「被擋」—— 按鈕要寫「靜音中」，按下去是解除靜音', () => {
    window.localStorage.setItem(MUTE_STORAGE_KEY, '1');
    const { btn } = mount({ speechErr: 'not-allowed' });
    expect(btn().textContent).toBe('muted');
    fireEvent.click(btn());
    expect(btn().textContent).toBe('blocked');
  });

  test('voiceBlockedBy：靜音時一律不算被擋；not-allowed 與含 autoplay 的標籤各算一條；已確認過的標籤不再算', () => {
    const base = { muted: false, speechErr: null, voiceName: null, autoplayAck: null };
    expect(voiceBlockedBy(base)).toBe(false);
    expect(voiceBlockedBy({ ...base, speechErr: 'not-allowed' })).toBe(true);
    expect(voiceBlockedBy({ ...base, speechErr: 'not-allowed', muted: true })).toBe(false);
    expect(voiceBlockedBy({ ...base, voiceName: `x-${AUTOPLAY_BLOCKED}-y` })).toBe(true);
    expect(
      voiceBlockedBy({ ...base, voiceName: `x-${AUTOPLAY_BLOCKED}-y`, autoplayAck: `x-${AUTOPLAY_BLOCKED}-y` })
    ).toBe(false);
    expect(voiceBlockedBy({ ...base, speechErr: 'synthesis-failed' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC-2 的終局條件（票上留言 (a)）
// ---------------------------------------------------------------------------

describe('#83 AC-2：語音開關在 MascotPanel.tsx 裡已經收乾淨', () => {
  const SRC = path.resolve(__dirname, '../..');
  const panel = fs.readFileSync(path.join(SRC, 'components/MascotPanel.tsx'), 'utf8');

  /** 遞迴列出 src/ 下的生產碼（排除 __tests__）。 */
  function srcFiles(dir: string = SRC): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__') {
          out.push(...srcFiles(f));
        }
      } else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) {
        out.push(f);
      }
    }
    return out;
  }

  /** 哪幾支生產碼提到這個識別字（回 src/ 相對路徑）。 */
  function mentions(re: RegExp): string[] {
    return srcFiles()
      .filter((f) => re.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC, f))
      .sort();
  }

  test('元件不再提及補念佇列、靜音儲存與 autoplay 的任何識別字', () => {
    const hits = panel.match(
      /blockedRef|BLOCKED_REPLAY|AUTOPLAY_BLOCKED|autoplayAck|mutedRef|setMuted|MUTE_EVENT|MUTE_STORAGE_KEY|readMuted|writeMuted|publishMuted|watchMuted/g
    );
    expect(hits).toBeNull();
  });

  test('靜音儲存與同步的消費端只有 useVoiceSwitch 一處', () => {
    expect(mentions(/\bwatchMuted\b/)).toEqual(['components/useVoiceSwitch.ts', 'speech/muteStore.ts']);
    expect(mentions(/\bpublishMuted\b/)).toEqual(['components/useVoiceSwitch.ts', 'speech/muteStore.ts']);
    expect(mentions(/\breadMuted\b/)).toEqual(['components/useVoiceSwitch.ts', 'speech/muteStore.ts']);
  });

  test('補念佇列的消費端只有 useVoiceSwitch 一處', () => {
    expect(mentions(/\bcreateBlockedQueue\b/)).toEqual(['components/useVoiceSwitch.ts', 'speech/blockedQueue.ts']);
  });
});
