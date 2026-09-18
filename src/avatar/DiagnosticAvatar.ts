/**
 * `AvatarController` 的第一個實作 —— **不是吉祥物**，是把契約的四個輸入
 * （表情 / 講話 / 視線格 / 張口幅度）直接畫成儀表。
 *
 * 為什麼不先做一個佔位精靈圖：使用者已裁定「重新產一套專用 sprite」，
 * 畫一套假的會讓人以為素材決定已經做完。這支反過來 —— 它長得**明顯不是**吉祥物，
 * 但它證明兩件事：契約可實作，而視線與嘴型的機制是活的。
 * `SpriteController`（P5）會是同一個介面的第二個實作，屆時只換 class 不動上層。
 *
 * 3×3 的排版刻意與精靈圖一致（row-major、4 為中央），所以格號的語意可以目視驗證。
 */
import type { AvatarController, Emotion } from './AvatarController';
import { CENTER_CELL } from './gaze';

const EMOTION_HUE: Record<Emotion, string> = {
  calm: '#4a8fd4',
  warning: '#d99b28',
  critical: '#d4504a',
  resolved: '#3da37a',
};

export class DiagnosticAvatar implements AvatarController {
  readonly kind = 'diagnostic';

  private root: HTMLElement | null = null;
  private cells: HTMLElement[] = [];
  private mouthEl: HTMLElement | null = null;
  private emotion: Emotion = 'calm';
  private speaking = false;
  private mouth = 0;
  private gaze = CENTER_CELL;
  private reaction: 'click' | 'pending' | null = null;
  private raf = 0;
  private t0 = 0;

  mount(container: HTMLElement): void {
    const root = document.createElement('div');
    root.style.cssText = 'display:flex;align-items:center;gap:10px;';

    const grid = document.createElement('div');
    grid.style.cssText =
      'display:grid;grid-template-columns:repeat(3,10px);grid-template-rows:repeat(3,10px);gap:2px;flex:0 0 auto;';
    grid.setAttribute('aria-label', '視線方向（3×3 格，中央為不看任何方向）');
    for (let i = 0; i < 9; i++) {
      const c = document.createElement('div');
      c.style.cssText = 'width:10px;height:10px;border-radius:2px;background:currentColor;opacity:0.18;';
      grid.appendChild(c);
      this.cells.push(c);
    }

    const mouth = document.createElement('div');
    mouth.style.cssText = 'width:10px;border-radius:2px;flex:0 0 auto;';
    mouth.setAttribute('aria-label', '嘴型');

    root.appendChild(grid);
    root.appendChild(mouth);
    container.appendChild(root);

    this.root = root;
    this.mouthEl = mouth;
    this.t0 = performance.now();
    this.loop();
  }

  private loop = (): void => {
    this.raf = requestAnimationFrame(this.loop);
    const color = EMOTION_HUE[this.emotion];

    // reaction 在儀表上的呈現：click 讓整個網格閃一下，pending 讓中央格慢速呼吸。
    // 精靈圖版會改成各自的反應格，但語意相同 —— 這裡是讓它看得見。
    const pulse =
      this.reaction === 'pending' ? 0.35 + 0.35 * Math.sin((performance.now() - this.t0) / 420) : 0;
    for (let i = 0; i < this.cells.length; i++) {
      const on = i === this.gaze;
      const el = this.cells[i]!;
      el.style.background = color;
      const base = on ? 1 : 0.18;
      const withPending = i === CENTER_CELL ? Math.max(base, pulse) : base;
      el.style.opacity = String(this.reaction === 'click' ? Math.max(withPending, 0.7) : withPending);
    }

    // setMouthOpen 有值時用它；否則在 speaking 期間跑定速嘴型。
    // 這正是 AvatarController 兩種嘴型來源的取捨點 —— 精靈圖實作也照這個規則。
    let open = this.mouth;
    if (open === 0 && this.speaking) {
      const phase = ((performance.now() - this.t0) % 260) / 260;
      open = phase < 0.5 ? 0.8 : 0.15;
    }
    if (this.mouthEl) {
      this.mouthEl.style.height = `${2 + open * 14}px`;
      this.mouthEl.style.background = color;
    }
  };

  setEmotion(e: Emotion): void {
    this.emotion = e;
  }

  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
    if (!speaking) {
      this.mouth = 0;
    }
  }

  setGaze(cell: number): void {
    this.gaze = Math.max(0, Math.min(8, Math.trunc(cell)));
  }

  setMouthOpen(open: number): void {
    this.mouth = Math.max(0, Math.min(1, open));
  }

  setReaction(kind: 'click' | 'pending' | null): void {
    this.reaction = kind;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.root?.remove();
    this.root = null;
    this.cells = [];
    this.mouthEl = null;
  }
}
