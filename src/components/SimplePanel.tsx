import React from 'react';
import { PanelProps } from '@grafana/data';
import { MascotPanelOptions } from '../panelOptions';
import { css } from '@emotion/css';
import { useStyles2 } from '@grafana/ui';

interface Props extends PanelProps<MascotPanelOptions> {}

/**
 * ⚠️ 這不是 Mascot 本體，是**丟棄式的 alertState 探測器**（ADR-004 POC 階段）。
 *
 * 它存在的唯一理由：ADR-004 決策 2 選了 `props.data.alertState` 當告警來源，
 * 但查證只到「型別上有這個欄位、標 @internal」，沒有人看過它在真實 Grafana 13.2.x
 * 上實際回什麼。而 handoff §三 那個「會反向決定 src/core/ 存廢」的架構分叉
 * （alertState 不含 alertname / severity / summary 時，severity.ts 與 format.ts
 * 在該路徑上沒有輸入），只有拿到真數據才決定得了。
 *
 * P4 開工時整支刪掉。
 */
const getStyles = () => ({
  wrap: css`
    height: 100%;
    overflow: auto;
    font-size: 12px;
    line-height: 1.5;
  `,
  h: css`
    font-weight: 600;
    margin: 0 0 4px;
    font-size: 13px;
  `,
  block: css`
    margin-bottom: 12px;
  `,
  pre: css`
    font-family: ui-monospace, monospace;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-all;
    margin: 0;
    padding: 6px 8px;
    border-radius: 3px;
    background: rgba(127, 127, 127, 0.12);
  `,
  absent: css`
    font-weight: 600;
    color: #d44;
  `,
});

export const SimplePanel: React.FC<Props> = ({ data, fieldConfig, id, timeRange }) => {
  const styles = useStyles2(getStyles);

  const alertState = (data as unknown as { alertState?: unknown }).alertState;

  const seriesSummary = data.series.map((f) => ({
    name: f.name ?? null,
    refId: f.refId ?? null,
    length: f.length,
    fields: f.fields.map((fl) => ({
      name: fl.name,
      type: fl.type,
      // 只取最後一點，避免把整條時序倒出來。
      last: fl.values.length ? fl.values[fl.values.length - 1] : null,
    })),
  }));

  const thresholds = fieldConfig.defaults.thresholds ?? null;

  return (
    <div className={styles.wrap}>
      <div className={styles.block}>
        <p className={styles.h}>props.data.alertState（panelId {id}）</p>
        {alertState === undefined ? (
          <p className={styles.absent}>undefined —— 四個硬前提至少缺一個</p>
        ) : (
          <pre className={styles.pre}>{JSON.stringify(alertState, null, 2)}</pre>
        )}
      </div>

      <div className={styles.block}>
        <p className={styles.h}>data.state / 時間範圍</p>
        <pre className={styles.pre}>
          {JSON.stringify({ state: data.state, from: timeRange.raw.from, to: timeRange.raw.to }, null, 2)}
        </pre>
      </div>

      <div className={styles.block}>
        <p className={styles.h}>data.series（{data.series.length} 條）</p>
        <pre className={styles.pre}>{JSON.stringify(seriesSummary, null, 2)}</pre>
      </div>

      <div className={styles.block}>
        <p className={styles.h}>fieldConfig.defaults.thresholds</p>
        <pre className={styles.pre}>{JSON.stringify(thresholds, null, 2)}</pre>
      </div>
    </div>
  );
};
