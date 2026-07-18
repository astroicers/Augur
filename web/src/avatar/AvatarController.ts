// The avatar-agnostic contract (Augur ADR-002). The App drives ANY avatar format
// through ONLY this interface; swapping VRM <-> Live2D changes the implementation
// class, nothing else. Emotion uses the §6 vocabulary the director emits
// (BroadcastPlan.emotion); each controller maps it to its own presets/params.

export type Emotion = "calm" | "warning" | "critical" | "resolved";

export interface AvatarController {
  /** Human-readable id, e.g. "vrm" or "live2d" (for the on-screen badge). */
  readonly kind: string;

  /**
   * Create the renderer on `canvas` and load the avatar. Owns its own render
   * loop (started here) that each frame applies the latest mouth + emotion +
   * idle motion. Resolves when the avatar is on screen.
   */
  mount(canvas: HTMLCanvasElement): Promise<void>;

  /** Latest mouth-open amount 0..1 — the App calls this every frame from the audio-RMS loop. */
  setMouth(open: number): void;

  /** Current emotion — the App calls this once per broadcast (from BroadcastPlan.emotion). */
  setEmotion(e: Emotion): void;

  /** Tear down the renderer and free GPU resources. */
  dispose(): void;
}
