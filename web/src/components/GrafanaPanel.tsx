// 選配的 Grafana 面板嵌入（ADR-003 P3）。設 VITE_GRAFANA_PANEL_URL 才顯示——
// 建議用 Grafana panel 的 kiosk/嵌入 URL（&kiosk 或 /d-solo/...）。
// 需 Grafana 端允許嵌入（grafana.ini：allow_embedding = true），否則會被 CSP/X-Frame 擋。
const PANEL_URL = (import.meta.env.VITE_GRAFANA_PANEL_URL as string | undefined) ?? "";

export function GrafanaPanel() {
  if (!PANEL_URL) return null;
  return (
    <aside className="absolute bottom-4 left-4 z-10 h-[240px] w-[420px] overflow-hidden rounded border border-slate-700 shadow-lg">
      <iframe title="Grafana" src={PANEL_URL} className="h-full w-full border-0 bg-slate-900" />
    </aside>
  );
}
