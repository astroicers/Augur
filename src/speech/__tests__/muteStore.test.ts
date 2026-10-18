/**
 * `muteStore` 的單元測試（#82）。
 *
 * 這一段原本只被 `MascotPanel.test.tsx` 間接涵蓋：面板渲染得出來的只有
 * 「按鈕顯示什麼、本機存了什麼」，而本機儲存讀／寫**拋例外**的退路與
 * storage 事件的過濾條件在那裡驗不到（jsdom 的 localStorage 不會自己壞，
 * 其他分頁的 storage 事件也要手工造）。
 *
 * ADR-007 的相容面在這裡釘死：鍵名 `augur-mascot-panel.muted`、
 * 事件名 `augur-mascot-panel:muted`——改了的話升級前存下的靜音讀不回來、
 * 同一頁上的新舊 panel 也不再互相同步。
 */
import {
  MUTE_EVENT,
  MUTE_STORAGE_KEY,
  mutedFromStorageEvent,
  publishMuted,
  readMuted,
  watchMuted,
  writeMuted,
} from '../muteStore';

/** 把 `window.localStorage` 換成會拋例外的那種（無痕模式、配額滿）。回傳還原函式。 */
function breakLocalStorage(how: { read?: boolean; write?: boolean }): () => void {
  const real = window.localStorage;
  const fake: Partial<Storage> = {
    getItem: (k: string) => {
      if (how.read) {
        throw new DOMException('denied', 'SecurityError');
      }
      return real.getItem(k);
    },
    setItem: (k: string, v: string) => {
      if (how.write) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      real.setItem(k, v);
    },
  };
  Object.defineProperty(window, 'localStorage', { value: fake, configurable: true });
  return () => Object.defineProperty(window, 'localStorage', { value: real, configurable: true });
}

afterEach(() => {
  window.localStorage.clear();
});

describe('#82：ADR-007 的相容面', () => {
  test('鍵名與事件名是升級前後共用的那兩個字串', () => {
    expect(MUTE_STORAGE_KEY).toBe('augur-mascot-panel.muted');
    expect(MUTE_EVENT).toBe('augur-mascot-panel:muted');
  });
});

describe('#82：readMuted', () => {
  test("存的是 '1' 才算靜音", () => {
    window.localStorage.setItem(MUTE_STORAGE_KEY, '1');
    expect(readMuted()).toBe(true);
  });

  test('沒存過（讀不到）＝沒靜音', () => {
    expect(readMuted()).toBe(false);
  });

  test("存的是 '0' 或其他值都不算靜音", () => {
    window.localStorage.setItem(MUTE_STORAGE_KEY, '0');
    expect(readMuted()).toBe(false);
    window.localStorage.setItem(MUTE_STORAGE_KEY, 'true');
    expect(readMuted()).toBe(false);
  });

  test('localStorage 被封鎖（讀的時候拋例外）時回 false，不往外拋', () => {
    const restore = breakLocalStorage({ read: true });
    try {
      expect(readMuted()).toBe(false);
    } finally {
      restore();
    }
  });
});

describe('#82：writeMuted', () => {
  test("true 寫 '1'、false 寫 '0'（兩種都寫，不是靠刪鍵表示沒靜音）", () => {
    writeMuted(true);
    expect(window.localStorage.getItem(MUTE_STORAGE_KEY)).toBe('1');
    writeMuted(false);
    expect(window.localStorage.getItem(MUTE_STORAGE_KEY)).toBe('0');
  });

  test('寫入拋例外（無痕模式、配額滿）時不往外拋', () => {
    const restore = breakLocalStorage({ write: true });
    try {
      expect(() => writeMuted(true)).not.toThrow();
    } finally {
      restore();
    }
  });
});

describe('#82：publishMuted', () => {
  test('寫本機並在同一頁發出 MUTE_EVENT，detail 是新的狀態', () => {
    const seen: unknown[] = [];
    const onMute = (e: Event) => seen.push((e as CustomEvent<boolean>).detail);
    window.addEventListener(MUTE_EVENT, onMute);
    try {
      publishMuted(true);
      expect(window.localStorage.getItem(MUTE_STORAGE_KEY)).toBe('1');
      expect(seen).toEqual([true]);
    } finally {
      window.removeEventListener(MUTE_EVENT, onMute);
    }
  });

  test('寫入拋例外時事件照發（同頁同步不依賴本機儲存成功）', () => {
    const seen: unknown[] = [];
    const onMute = (e: Event) => seen.push((e as CustomEvent<boolean>).detail);
    window.addEventListener(MUTE_EVENT, onMute);
    const restore = breakLocalStorage({ write: true });
    try {
      expect(() => publishMuted(true)).not.toThrow();
      expect(seen).toEqual([true]);
    } finally {
      restore();
      window.removeEventListener(MUTE_EVENT, onMute);
    }
  });
});

describe('#82：mutedFromStorageEvent', () => {
  test("是我們的鍵：newValue '1' → true，其他值 → false", () => {
    expect(mutedFromStorageEvent(new StorageEvent('storage', { key: MUTE_STORAGE_KEY, newValue: '1' }))).toBe(true);
    expect(mutedFromStorageEvent(new StorageEvent('storage', { key: MUTE_STORAGE_KEY, newValue: '0' }))).toBe(false);
  });

  test('整個 localStorage 被清掉（key 是 null）不算我們的事件', () => {
    expect(mutedFromStorageEvent(new StorageEvent('storage', { key: null, newValue: null }))).toBeNull();
  });

  test('別人的鍵回 null —— 否則同一頁的其他設定會把吉祥物靜音', () => {
    expect(mutedFromStorageEvent(new StorageEvent('storage', { key: 'grafana.theme', newValue: '1' }))).toBeNull();
  });
});

describe('#82：watchMuted', () => {
  test('同一頁其他 panel 發的 MUTE_EVENT 會通知', () => {
    const seen: boolean[] = [];
    const stop = watchMuted((m) => seen.push(m));
    try {
      window.dispatchEvent(new CustomEvent<boolean>(MUTE_EVENT, { detail: true }));
      window.dispatchEvent(new CustomEvent<boolean>(MUTE_EVENT, { detail: false }));
      expect(seen).toEqual([true, false]);
    } finally {
      stop();
    }
  });

  test('其他分頁的 storage 事件會通知（我們的鍵才算）', () => {
    const seen: boolean[] = [];
    const stop = watchMuted((m) => seen.push(m));
    try {
      window.dispatchEvent(new StorageEvent('storage', { key: MUTE_STORAGE_KEY, newValue: '1' }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'other.key', newValue: '1' }));
      window.dispatchEvent(new StorageEvent('storage', { key: MUTE_STORAGE_KEY, newValue: '0' }));
      expect(seen).toEqual([true, false]);
    } finally {
      stop();
    }
  });

  test('解除訂閱之後兩種事件都不再通知（panel unmount 後不得再 setState）', () => {
    const seen: boolean[] = [];
    watchMuted((m) => seen.push(m))();
    window.dispatchEvent(new CustomEvent<boolean>(MUTE_EVENT, { detail: true }));
    window.dispatchEvent(new StorageEvent('storage', { key: MUTE_STORAGE_KEY, newValue: '1' }));
    expect(seen).toEqual([]);
  });
});
