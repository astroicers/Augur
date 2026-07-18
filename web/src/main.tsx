import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// 無 StrictMode：avatar controller 擁有自己的命令式 three/pixi 渲染迴圈，
// double-mount 會產生兩個 WebGL context。
createRoot(document.getElementById("root")!).render(<App />);
