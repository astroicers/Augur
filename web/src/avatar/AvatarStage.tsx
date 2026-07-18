import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from "react";
import type { AvatarController, Emotion } from "./AvatarController";
import { VrmController } from "./VrmController";
import { Live2DController } from "./Live2DController";

export interface AvatarStageHandle {
  /** Must be called from a user gesture to unlock/resume the AudioContext. */
  unlockAudio: () => void;
  /** Enqueue a broadcast: switch expression + (if unlocked) speak the audio with lip-sync. */
  playBroadcast: (emotion: Emotion, audioB64: string) => void;
}

const W = window as unknown as Record<string, unknown>;

function pickMode(): "vrm" | "live2d" {
  return new URLSearchParams(location.search).get("avatar") === "live2d" ? "live2d" : "vrm";
}

/**
 * Owns the canvas + the chosen AvatarController + the audio graph. Audio is played
 * via Web Audio (decodeAudioData → AudioBufferSourceNode → analyser → destination),
 * NOT an <audio> element (autoplay policy blocks a media element's play() that far
 * from the user gesture). Broadcasts are QUEUED and played one at a time — a second
 * alert waits for the first to finish instead of cutting it off / overlapping audio.
 * The RMS loop reads the analyser → controller.setMouth every frame (lip-sync).
 */
export const AvatarStage = forwardRef<AvatarStageHandle>(function AvatarStage(_props, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<AvatarController | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const queueRef = useRef<Array<{ emotion: Emotion; b64: string }>>([]);
  const playingRef = useRef(false);

  const mode = pickMode();

  useEffect(() => {
    W.__avatarMode = mode;
    const controller: AvatarController = mode === "live2d" ? new Live2DController() : new VrmController();
    controllerRef.current = controller;
    let raf = 0;

    controller
      .mount(canvasRef.current!)
      .then(() => {
        W.__avatarReady = true;
      })
      .catch((e) => console.error("[AvatarStage] mount error:", e));

    const loop = () => {
      raf = requestAnimationFrame(loop);
      let mouth = 0;
      const an = analyserRef.current;
      const buf = dataRef.current;
      if (an && buf) {
        an.getByteTimeDomainData(buf);
        let s = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i]! - 128) / 128;
          s += v * v;
        }
        mouth = Math.min(1, Math.sqrt(s / buf.length) * 11);
      }
      W.__mouth = mouth;
      if (mouth > 0.3) W.__spoke = true;
      controllerRef.current?.setMouth(mouth);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      controller.dispose();
    };
  }, [mode]);

  // Play the next queued broadcast, one at a time (no overlap / cut-off).
  const pump = useCallback(() => {
    if (playingRef.current) return;
    const next = queueRef.current.shift();
    if (!next) return;
    playingRef.current = true;
    controllerRef.current?.setEmotion(next.emotion);

    const done = () => {
      playingRef.current = false;
      pump();
    };

    const ctx = ctxRef.current;
    const an = analyserRef.current;
    if (!next.b64 || !ctx || !an) {
      // 音訊未解鎖：只換表情，短暫停頓後續播下一則。
      W.__spoke = true;
      setTimeout(done, 1200);
      return;
    }
    const bytes = Uint8Array.from(atob(next.b64), (c) => c.charCodeAt(0));
    void ctx
      .resume()
      .then(() => ctx.decodeAudioData(bytes.buffer))
      .then((audioBuf) => {
        const src = ctx.createBufferSource();
        src.buffer = audioBuf;
        src.connect(an);
        src.onended = done;
        sourceRef.current = src;
        src.start();
      })
      .catch((e) => {
        console.error("[AvatarStage] audio play error:", e);
        done();
      });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      unlockAudio: () => {
        if (ctxRef.current) {
          void ctxRef.current.resume();
          return;
        }
        const ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        an.connect(ctx.destination);
        ctxRef.current = ctx;
        analyserRef.current = an;
        dataRef.current = new Uint8Array(new ArrayBuffer(an.fftSize));
        void ctx.resume();
      },
      playBroadcast: (emotion: Emotion, audioB64: string) => {
        queueRef.current.push({ emotion, b64: audioB64 });
        pump();
      },
    }),
    [pump],
  );

  return <canvas ref={canvasRef} className="fixed inset-0 z-0" />;
});
