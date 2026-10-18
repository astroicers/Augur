/**
 * `unavailableSpeaker` 的單元測試（#82）。
 *
 * 這支是「沒有 `speechSynthesis` 的環境」的接手者：Web Speech 不存在時
 * `createSpeaker` 不該被呼叫，而 remoteSpeaker 的降級路徑仍要有東西可以交。
 * 它必須把每一則都報成錯誤、而不是靜靜吞掉 —— 吞掉的話畫面上看起來在念、
 * 實際上沒有聲音也沒有錯誤訊息。
 */
import type { BroadcastPlan } from '../../core/types';
import type { SpeakerEvents } from '../speaker';
import { unavailableSpeaker } from '../unavailableSpeaker';

const plan = (name: string): BroadcastPlan => ({
  text: `${name} 很吵`,
  severity: 'critical',
  emotion: 'critical',
  name,
  status: 'firing',
});

describe('#82：unavailableSpeaker', () => {
  test('每一則都回報 no-speech-synthesis 錯誤，並帶著原本那個 plan 物件', () => {
    const errors: Array<[string, BroadcastPlan | undefined]> = [];
    const ev: SpeakerEvents = { onError: (reason, p) => errors.push([reason, p]) };
    const sp = unavailableSpeaker(ev);
    const p1 = plan('CPU');
    sp.enqueue(p1);
    expect(errors).toHaveLength(1);
    expect(errors[0]![0]).toBe('no-speech-synthesis');
    // 物件身分要原樣轉交：試聽與補念都靠它分辨（remoteSpeaker 同樣以物件身分比對）。
    expect(errors[0]![1]).toBe(p1);
  });

  test('沒有 onError 的事件物件也不炸 —— 事件全是選填', () => {
    const sp = unavailableSpeaker({});
    expect(() => sp.enqueue(plan('CPU'))).not.toThrow();
  });

  test('佇列永遠是空的、永遠不在念；unlock／stop／dispose 可呼叫且無副作用', () => {
    const sp = unavailableSpeaker({ onError: () => {} });
    sp.enqueue(plan('CPU'));
    expect(sp.pending()).toBe(0);
    expect(sp.isSpeaking()).toBe(false);
    expect(sp.voiceName()).toBeNull();
    expect(() => {
      sp.unlock();
      sp.stop();
      sp.dispose();
    }).not.toThrow();
    expect(sp.pending()).toBe(0);
  });
});
