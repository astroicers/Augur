/**
 * `downloadTextFile` 的單元測試（#101）。
 *
 * ## 這一份測試摸得到什麼、摸不到什麼
 *
 * jsdom 不下載，也沒有 `URL.createObjectURL` —— 所以「下載下來的檔名是什麼」在這裡**驗不到**，
 * 那一半只有真的瀏覽器算得清（見 `.asp/pr/101.md`）。驗得到的是兩件可觀察的事，而 #101 的缺陷
 * 正好整個落在這兩件事上：
 *
 *  1. **頁面層的攔截器收不到這個點擊**（收到了就有機會 `preventDefault()`，`download` 屬性
 *     就不被採用 —— 那就是實測到的 uuid 檔名）；
 *  2. **預設動作沒有被取消**（`defaultPrevented === false`）。jsdom 的 dispatch 在這個條件下
 *     會真的去「跟著連結走」，所以本檔把 object URL 的替身做成**同文件的 fragment**
 *     （`#augur-download-<n>`）：jsdom 對 hash 導航是實作了的，於是「預設動作到底有沒有發生」
 *     變成一個看得見的斷言（`location.hash`），而不是只能看 `defaultPrevented`。
 *     真實的 `blob:` 位址在這裡會換成一行 `Not implemented: navigation` 的噪音，驗到的卻更少。
 *
 * 第 3 支是**落槌**：同一個假攔截器對「沒有屏蔽」的 `<a>` 確實吃得下去。少了它，前兩支
 * 可以在缺陷照舊存在的情況下通過（票上留言 (a) 指的就是這件事）。
 */
import { downloadTextFile } from '../downloadTextFile';

const CSV_MIME = 'text/csv;charset=utf-8';

/** 攔下 object URL 的生成與回收；回傳的 `urls` 依序是每次 `createObjectURL` 給出的位址。 */
function stubObjectUrls() {
  const url = URL as unknown as { createObjectURL?: unknown; revokeObjectURL?: unknown };
  const realCreate = url.createObjectURL;
  const realRevoke = url.revokeObjectURL;
  const urls: string[] = [];
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  let seq = 0;

  url.createObjectURL = (b: Blob) => {
    blobs.push(b);
    // 同文件 fragment，理由見檔頭第 2 點。每次都不一樣，否則「導航過了」看不出來。
    const u = `#augur-download-${++seq}`;
    urls.push(u);
    return u;
  };
  url.revokeObjectURL = (u: string) => revoked.push(u);

  return {
    urls,
    blobs,
    revoked,
    restore() {
      url.createObjectURL = realCreate;
      // 還排在下一個 task 的那次 revoke 可能晚於 restore 才跑；jsdom 本來就沒有這個函式，
      // 還原成 undefined 會讓那個計時器丟錯、染紅**下一支**測試。
      url.revokeObjectURL = realRevoke ?? ((u: string) => revoked.push(u));
    },
  };
}

/**
 * 假的頁面層連結攔截器：掛在 `document` 上，收到點擊就記一筆並 `preventDefault()`。
 *
 * `preventDefault()` 是刻意的 —— Grafana 那個攔截器就是取消預設動作之後自己去導航 `href`，
 * 而那正是 `download` 屬性沒被採用、檔名變成 blob 路徑（uuid）的成因。
 */
function fakeInterceptor(phase: 'capture' | 'bubble') {
  const seen: Array<{ tag: string; download: string | null }> = [];
  const capture = phase === 'capture';
  const onClick = (e: Event) => {
    const el = e.target as HTMLElement;
    seen.push({ tag: el.tagName, download: el.getAttribute?.('download') ?? null });
    e.preventDefault();
  };
  document.addEventListener('click', onClick, capture);
  return {
    seen,
    remove() {
      document.removeEventListener('click', onClick, capture);
    },
  };
}

/**
 * 在 window 捕獲階段**比本函式更早**註冊一個旁觀者，用來看那個點擊當下的狀態。
 *
 * 不呼叫 `preventDefault()`、不停止傳播 —— 只記錄。註冊得比屏蔽早，所以屏蔽攔不住它
 * （`stopImmediatePropagation` 只能停掉還沒跑的 listener）。
 */
function clickObserver() {
  const seen: Array<{ target: EventTarget | null; inDocument: boolean; download: string | null; href: string }> = [];
  let last: Event | undefined;
  const onClick = (e: Event) => {
    const el = e.target as HTMLAnchorElement;
    last = e;
    seen.push({
      target: e.target,
      inDocument: document.body.contains(el),
      download: el.getAttribute('download'),
      href: el.getAttribute('href') ?? '',
    });
  };
  window.addEventListener('click', onClick, true);
  return {
    seen,
    /** 派送結束後才有意義：預設動作有沒有被取消。 */
    defaultPrevented: () => last?.defaultPrevented,
    remove() {
      window.removeEventListener('click', onClick, true);
    },
  };
}

/** 等下一個 macrotask —— jsdom 的「跟著連結走」與本函式的 revoke 都排在那裡。 */
const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  window.location.hash = '';
});

afterEach(() => {
  window.location.hash = '';
});

test('#101 AC-1／AC-3：document 冒泡階段的連結攔截器收不到這個點擊，而且預設動作沒被取消', async () => {
  const cap = stubObjectUrls();
  const interceptor = fakeInterceptor('bubble');
  const observer = clickObserver();
  try {
    downloadTextFile('a,b\r\n', 'augur-broadcast-dash1-panel7-20261019T000000Z.csv', CSV_MIME);

    // 攔截器一次都沒被呼叫 —— 它沒有機會 preventDefault，`download` 屬性因此還是有效的那一方。
    expect(interceptor.seen).toEqual([]);
    // 點擊當下 `<a>` 帶著算好的檔名（AC-1 的那個值）。
    expect(observer.seen).toHaveLength(1);
    expect(observer.seen[0]!.download).toBe('augur-broadcast-dash1-panel7-20261019T000000Z.csv');
    expect(observer.defaultPrevented()).toBe(false);

    // 預設動作真的發生了：jsdom 跟著連結走到那個 fragment（排在下一個 task）。
    await nextTask();
    expect(window.location.hash).toBe(cap.urls[0]);
  } finally {
    observer.remove();
    interceptor.remove();
    cap.restore();
  }
});

test('#101 AC-3：攔截器掛在 document 的捕獲階段也一樣收不到 —— 捕獲的順序是 window 比 document 早', async () => {
  const cap = stubObjectUrls();
  const interceptor = fakeInterceptor('capture');
  const observer = clickObserver();
  try {
    downloadTextFile('a,b\r\n', 'augur-broadcast-panel7-20261019T000000Z.csv', CSV_MIME);

    expect(interceptor.seen).toEqual([]);
    expect(observer.seen[0]!.download).toBe('augur-broadcast-panel7-20261019T000000Z.csv');
    expect(observer.defaultPrevented()).toBe(false);
    await nextTask();
    expect(window.location.hash).toBe(cap.urls[0]);
  } finally {
    observer.remove();
    interceptor.remove();
    cap.restore();
  }
});

test('#101 AC-3 落槌：同一個假攔截器對「沒有屏蔽」的 <a> 真的吃得下去（上兩支不是空轉）', async () => {
  const interceptor = fakeInterceptor('capture');
  try {
    // 這四行是 #101 之前的 `downloadTextFile`（只少了 Blob 那一段）。
    const a = document.createElement('a');
    a.href = '#augur-download-control';
    a.download = 'should-not-survive.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();

    // 攔截器收到了、而且取消了預設動作 —— 真實瀏覽器在這一步就不採用 `download` 了。
    expect(interceptor.seen).toEqual([{ tag: 'A', download: 'should-not-survive.csv' }]);
    await nextTask();
    expect(window.location.hash).toBe(''); // 連結沒有被跟著走
  } finally {
    interceptor.remove();
  }
});

test('#101 AC-2：點擊發生的那一刻 <a> 在 document 裡（Firefox 的條件），派送完才移走', async () => {
  const cap = stubObjectUrls();
  const observer = clickObserver();
  try {
    const before = document.body.childElementCount;
    downloadTextFile('x', 'augur.csv', CSV_MIME);

    expect(observer.seen).toHaveLength(1);
    expect(observer.seen[0]!.inDocument).toBe(true);
    expect(observer.seen[0]!.href).toBe(cap.urls[0]);
    // 收尾：畫面上不留東西。
    expect(document.body.childElementCount).toBe(before);
    expect(document.querySelector('a[download]')).toBeNull();
    await nextTask();
  } finally {
    observer.remove();
    cap.restore();
  }
});

test('#101：object URL 排到下一個 task 才回收，回收的是那一個位址（搬家沒把時機弄壞）', async () => {
  const cap = stubObjectUrls();
  try {
    downloadTextFile('x', 'augur.csv', CSV_MIME);
    // 同一個 task 內還沒回收 —— 立刻 revoke 會讓還沒開始的下載被取消掉。
    expect(cap.revoked).toEqual([]);
    await nextTask();
    expect(cap.revoked).toEqual([cap.urls[0]]);
    // Blob 的 MIME 原樣傳下去（內容的格式由 feed/feedCsv 的測試釘）。
    expect(cap.blobs).toHaveLength(1);
    expect(cap.blobs[0]!.type).toBe(CSV_MIME);
  } finally {
    cap.restore();
  }
});

test('#101：屏蔽只吃自己那一個 <a> 的點擊 —— 同一瞬間派送的別人的點擊照舊傳到 document', async () => {
  const cap = stubObjectUrls();
  const other = document.createElement('div');
  document.body.appendChild(other);
  const onDocClick = jest.fn();
  document.addEventListener('click', onDocClick);

  // 比屏蔽更早註冊：看到我們那個 <a> 的點擊時，順手派送另一個元素的點擊。
  const nested = (e: Event) => {
    if ((e.target as HTMLElement).tagName === 'A') {
      other.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  };
  window.addEventListener('click', nested, true);
  try {
    downloadTextFile('x', 'augur.csv', CSV_MIME);

    // 只收到別人那一個（<a> 的那一個被屏蔽攔住了）。
    expect(onDocClick).toHaveBeenCalledTimes(1);
    expect((onDocClick.mock.calls[0]![0] as Event).target).toBe(other);
    await nextTask();
  } finally {
    window.removeEventListener('click', nested, true);
    document.removeEventListener('click', onDocClick);
    other.remove();
    cap.restore();
  }
});

test('#101：點擊派送完就把那個 listener 從 window 上拿掉 —— 不然每匯出一次就累積一個', async () => {
  const cap = stubObjectUrls();
  // 這一支只能從 add／remove 這一對看 —— 「window 上還掛著幾個 listener」在 DOM 上讀不到，
  // 而漏掉解除的症狀（listener 與它閉包裡的 `<a>` 隨每次匯出累積）也不會讓任何別的斷言變紅。
  const added = jest.spyOn(window, 'addEventListener');
  const removed = jest.spyOn(window, 'removeEventListener');
  try {
    downloadTextFile('x', 'augur.csv', CSV_MIME);

    const clickAdds = added.mock.calls.filter(([type]) => type === 'click');
    expect(clickAdds).toHaveLength(1);
    expect(clickAdds[0]![2]).toBe(true); // 捕獲階段
    expect(removed).toHaveBeenCalledWith('click', clickAdds[0]![1], true);
    await nextTask();
  } finally {
    added.mockRestore();
    removed.mockRestore();
    cap.restore();
  }
});
