import * as PIXI from "pixi.js";
import { Live2DModel } from "pixi-live2d-display-lipsyncpatch/cubism4";
import type { AvatarController, Emotion } from "./AvatarController";

// Live2D implementation of AvatarController — the future 2D "skin" (choice C).
// pixi-live2d-display needs PIXI on window + a registered ticker; Cubism Core is
// loaded globally by index.html. The /cubism4 subpath import is mandatory.
(window as unknown as { PIXI: typeof PIXI }).PIXI = PIXI;
Live2DModel.registerTicker(PIXI.Ticker);

// Sample Hiyori ships no .exp3.json → drive the director's §6 emotion at the
// PARAMETER level (per live2d-template-spec §6, mapped onto Hiyori's std params).
const EMOTION: Record<Emotion, { browY: number; browAngle: number; mouthForm: number; eyeSmile: number }> = {
  calm: { browY: 0, browAngle: 0, mouthForm: 0.2, eyeSmile: 0 },
  warning: { browY: -0.5, browAngle: 0, mouthForm: -0.2, eyeSmile: 0 },
  critical: { browY: -1, browAngle: -1, mouthForm: -0.6, eyeSmile: 0 },
  resolved: { browY: 0.4, browAngle: 0, mouthForm: 0.6, eyeSmile: 1 },
};

type CoreModel = { setParameterValueById(id: string, v: number): void };

export class Live2DController implements AvatarController {
  readonly kind = "live2d";

  private mouth = 0;
  private emotion: Emotion = "calm";
  private app: PIXI.Application | null = null;

  async mount(canvas: HTMLCanvasElement): Promise<void> {
    const app = new PIXI.Application({
      view: canvas,
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio, 2),
    });
    this.app = app;

    const model = await Live2DModel.from("/models/Hiyori.model3.json");
    app.stage.addChild(model);
    model.anchor.set(0.5, 0.08);
    model.scale.set((window.innerHeight / model.height) * 2.1);
    model.position.set(window.innerWidth / 2, 0);

    // internalModel is an EventEmitter at runtime but not typed as such.
    const im = model.internalModel as unknown as {
      on(ev: string, cb: () => void): void;
      coreModel: CoreModel;
    };
    const core = im.coreModel;
    im.on("afterMotionUpdate", () => {
      core.setParameterValueById("ParamMouthOpenY", this.mouth);
      const m = EMOTION[this.emotion];
      core.setParameterValueById("ParamBrowLY", m.browY);
      core.setParameterValueById("ParamBrowRY", m.browY);
      core.setParameterValueById("ParamBrowLAngle", m.browAngle);
      core.setParameterValueById("ParamBrowRAngle", m.browAngle);
      core.setParameterValueById("ParamMouthForm", m.mouthForm);
      core.setParameterValueById("ParamEyeLSmile", m.eyeSmile);
      core.setParameterValueById("ParamEyeRSmile", m.eyeSmile);
    });
  }

  setMouth(open: number): void {
    this.mouth = open;
  }

  setEmotion(e: Emotion): void {
    this.emotion = e;
  }

  dispose(): void {
    this.app?.destroy(true, { children: true });
    this.app = null;
  }
}
