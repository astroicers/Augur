import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRM, VRMLoaderPlugin } from "@pixiv/three-vrm";
import type { AvatarController, Emotion } from "./AvatarController";

// VRM implementation of AvatarController (Augur ADR-002/003). Proven in spikes A/D.
// Maps the director's §6 emotion → three-vrm expression presets.

const VRM_PRESET: Record<Emotion, "angry" | "surprised" | "happy" | null> = {
  calm: null, // 中性臉
  warning: "surprised",
  critical: "angry",
  resolved: "happy",
};
const PRESETS = ["angry", "surprised", "happy"] as const;

export class VrmController implements AvatarController {
  readonly kind = "vrm";

  private mouth = 0;
  private emotion: Emotion = "calm";

  private renderer: THREE.WebGLRenderer | null = null;
  private vrm: VRM | null = null;
  private raf = 0;
  private clock = new THREE.Clock();

  mount(canvas: HTMLCanvasElement): Promise<void> {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, window.innerWidth / window.innerHeight, 0.1, 20);
    camera.position.set(0, 1.32, 0.9);

    const dir = new THREE.DirectionalLight(0xffffff, 2.2);
    dir.position.set(1, 1.4, 1.2);
    scene.add(dir);
    scene.add(new THREE.AmbientLight(0xffffff, 1.4));

    const ready = new Promise<void>((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      loader.load(
        "/avatar.vrm",
        (gltf) => {
          const vrm = gltf.userData.vrm as VRM;
          vrm.scene.traverse((obj) => {
            obj.frustumCulled = false;
          });
          scene.add(vrm.scene);
          // VRM 預設是 T-pose（手平舉）——把上臂旋下成自然垂手，較像播報員。
          // 設一次即可：vrm.update() 每幀會把 normalized 骨旋轉套到 raw 骨。
          const la = vrm.humanoid?.getNormalizedBoneNode("leftUpperArm");
          const ra = vrm.humanoid?.getNormalizedBoneNode("rightUpperArm");
          if (la) la.rotation.z = -1.2;
          if (ra) ra.rotation.z = 1.2;
          this.vrm = vrm;
          resolve();
        },
        undefined,
        (err) => reject(err),
      );
    });

    this.clock = new THREE.Clock();
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      const dt = this.clock.getDelta();
      const t = this.clock.elapsedTime;
      const vrm = this.vrm;
      if (vrm) {
        const em = vrm.expressionManager;
        if (em) {
          em.setValue("aa", this.mouth);
          const preset = VRM_PRESET[this.emotion];
          for (const p of PRESETS) em.setValue(p, p === preset ? 0.9 : 0);
          em.setValue("neutral", 0);
          em.setValue("blink", Math.sin(t * 1.3) > 0.97 ? 1 : 0);
        }
        const head = vrm.humanoid?.getNormalizedBoneNode("head");
        if (head) head.rotation.y = Math.sin(t * 0.5) * 0.04;
        camera.lookAt(0, 1.32, 0);
        vrm.update(dt);
      }
      renderer.render(scene, camera);
    };
    tick();

    return ready;
  }

  setMouth(open: number): void {
    this.mouth = open;
  }

  setEmotion(e: Emotion): void {
    this.emotion = e;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.renderer?.dispose();
  }
}
