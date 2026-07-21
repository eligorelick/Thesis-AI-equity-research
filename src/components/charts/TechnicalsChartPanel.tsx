"use client";

/**
 * TechnicalsChartPanel — the client chart bundle mounted into the report's
 * Technicals section slot (ReportView's `technicalsChart` ReactNode) and used on
 * the company page. Composes the candlestick PriceChart (with SMA overlays +
 * cross markers) above the rebased RelativeStrengthChart.
 *
 * The server page maps its rich data (DataBundle / synthetic fixtures) into the
 * plain-object props via src/components/charts/map.ts and passes them here, so the
 * server/client boundary carries only serializable data — never a client component
 * across the wire.
 */

import { PriceChart, type PriceBar, type CrossMarker } from "./PriceChart";
import { RelativeStrengthChart, type RsSeries } from "./RelativeStrengthChart";

export interface TechnicalsChartPanelProps {
  bars: readonly PriceBar[];
  crosses?: readonly CrossMarker[];
  relativeStrength?: readonly RsSeries[];
  priceHeight?: number;
  rsHeight?: number;
}

export function TechnicalsChartPanel({
  bars,
  crosses,
  relativeStrength,
  priceHeight = 340,
  rsHeight = 240,
}: TechnicalsChartPanelProps) {
  const hasPrice = bars.length > 0;
  const hasRs = (relativeStrength?.length ?? 0) > 0;

  if (!hasPrice && !hasRs) {
    return (
      <div className="px-3 py-6 text-center text-[11px] text-faint">
        no price history available — technicals charts unavailable.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-3">
      {hasPrice ? (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-faint">
            price · candles + SMA50/200 + volume
          </div>
          <PriceChart rows={bars} crosses={crosses} height={priceHeight} />
        </div>
      ) : null}
      {hasRs ? (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-faint">
            relative strength · rebased to 100
          </div>
          <RelativeStrengthChart series={relativeStrength ?? []} height={rsHeight} />
        </div>
      ) : null}
    </div>
  );
}
