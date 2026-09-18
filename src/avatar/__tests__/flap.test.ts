import { createFlapDriver, flapAmplitude, flapCount } from '../flap';

test('flapCount：跟著 charLength 走，夾在 1–5', () => {
  expect(flapCount(1)).toBe(1);
  expect(flapCount(3)).toBe(3);
  expect(flapCount(5)).toBe(5);
  // 實測 charLength 最大到 14（「WindowsHighCPU」整組），但 600ms 的平均間隔塞不下 14 下。
  expect(flapCount(14)).toBe(5);
  expect(flapCount(0)).toBe(1);
  expect(flapCount(NaN)).toBe(1);
});

test('flapAmplitude：兩段而非連續，門檻取實測中位數 4', () => {
  expect(flapAmplitude(3)).toBeLessThan(flapAmplitude(4));
  expect(flapAmplitude(1)).toBe(flapAmplitude(3));
  expect(flapAmplitude(4)).toBe(flapAmplitude(14));
});

/** 假時鐘：把排進來的 callback 依序跑完，不用真的等。 */
function fakeClock() {
  const q: Array<{ id: number; fn: () => void }> = [];
  let next = 1;
  return {
    setTimeoutFn: (fn: () => void) => {
      const id = next++;
      q.push({ id, fn });
      return id;
    },
    clearTimeoutFn: (h: number) => {
      const i = q.findIndex((x) => x.id === h);
      if (i >= 0) {
        q.splice(i, 1);
      }
    },
    /** 跑完目前排隊的所有 callback（含它們再排的），最多 n 輪以免無限迴圈。 */
    drain(n = 60) {
      for (let i = 0; i < n && q.length; i++) {
        const t = q.shift()!;
        t.fn();
      }
    },
    size: () => q.length,
  };
}

test('boundary：charLength 決定擺動次數，跑完停在閉口', () => {
  const clock = fakeClock();
  const seen: number[] = [];
  const d = createFlapDriver((v) => seen.push(v), clock);

  d.boundary(2);
  clock.drain();

  // 兩下 = 張、閉、張、閉，最後一次 run(0) 再補一個閉口。
  expect(seen.filter((v) => v > 0)).toHaveLength(2);
  expect(seen[seen.length - 1]).toBe(0);
});

test('boundary：字多擺得多', () => {
  const clock = fakeClock();
  const seen: number[] = [];
  const d = createFlapDriver((v) => seen.push(v), clock);
  d.boundary(5);
  clock.drain();
  expect(seen.filter((v) => v > 0)).toHaveLength(5);
});

test('新的 boundary 取消上一輪剩下的擺動', () => {
  const clock = fakeClock();
  const seen: number[] = [];
  const d = createFlapDriver((v) => seen.push(v), clock);

  d.boundary(5); // 本來要擺 5 下
  d.boundary(1); // 馬上被下一個詞打斷，只擺 1 下

  clock.drain();

  // 第一輪的**第一次張口是同步發生的** —— boundary 是嘴型的同步點，
  // 張口不該等 110ms。所以被打斷的那一輪留下一次張口是正確的，
  // 關鍵是它剩下的 4 下沒有跑。若未取消會是 6 次張口。
  expect(seen.filter((v) => v > 0)).toHaveLength(2);
  expect(seen[seen.length - 1]).toBe(0);
});

test('stop() 清空並閉口', () => {
  const clock = fakeClock();
  const seen: number[] = [];
  const d = createFlapDriver((v) => seen.push(v), clock);
  d.boundary(5);
  d.stop();
  expect(seen[seen.length - 1]).toBe(0);
  expect(clock.size()).toBe(0);
});

test('idle()：沒有 boundary 可用時的定速 fallback，且重複呼叫不疊加', () => {
  const clock = fakeClock();
  const seen: number[] = [];
  const d = createFlapDriver((v) => seen.push(v), clock);

  d.idle();
  d.idle(); // 第二次應該是 no-op
  clock.drain(6);

  expect(seen.length).toBeGreaterThan(2);
  expect(seen.some((v) => v > 0)).toBe(true);
  expect(seen.some((v) => v === 0)).toBe(true);
});
