/**
 * /company/[symbol] — the Phase 1 THIN SLICE.
 *
 * Server component. Runs the real pipeline end to end for one ticker:
 *   buildDataBundle → validateBundle → runStageB
 * then renders a dense, terminal-grade research surface with the ui.tsx
 * primitives. Every rendered figure carries an <AsOf> stamp where provenance
 * exists; gaps render as disclosures, never as crashes. Unknown tickers land on
 * a friendly error rather than a 500.
 */

import Link from "next/link";
import { Suspense, type ReactNode } from "react";

import { AppShell } from "@/components/shell";
import { CompanyBodySkeleton, SidebarSkeleton } from "./skeletons";
import {
  AsOf,
  Badge,
  DataTable,
  GapNotice,
  Panel,
  StatCell,
  type Column,
  type Tone,
} from "@/components/ui";
import type { ManifestEntry, Sourced } from "@/types/core";

import { buildDataBundle } from "@/pipeline/dataBundle";
import type { DataBundle } from "@/pipeline/types";
import { validateBundle, type ValidationReport } from "@/pipeline/stageA/validate";
import { renderManifestSummary } from "@/pipeline/stageA/manifest";
import { runStageB, sourcedOf, type ComputedMetrics } from "@/pipeline/compute";
import type { AltmanZone } from "@/pipeline/stageB/forensics";

import { SensitivityHeatmap, type SensitivityCell } from "@/components/charts/SensitivityHeatmap";
import { FundamentalsChartGrid, TechnicalsChartPanel } from "@/components/charts/lazy";
import {
  fundamentalsChartDataFromBundle,
  priceChartPropsFromBundle,
  relativeStrengthSeriesFromBundle,
} from "@/components/charts/map";
import { ReportView } from "@/components/report/ReportView";
import { ExportButtons } from "@/components/report/ExportButtons";
import { WatchlistSidebar } from "@/components/watchlist/Sidebar";
import { getLatestDoneReport, type LatestReport } from "@/report/query";

import { fmtBig, fmtMoney, fmtNum, fmtPct, fmtSignedPct, fmtX, upsidePct } from "./format";
import { GenerateReport } from "./GenerateReport";
import { ReportTabs } from "./ReportTabs";
import { isValidSymbol } from "@/symbol";
import { notFound } from "next/navigation";

// The bundle reads keys from process.env at request time and hits the network
// (live EDGAR/FINRA/FRED even keyless) — never statically render this route.
export const dynamic = "force-dynamic";
// EDGAR + FMP fixtures + FRED can take several seconds; give it headroom.
export const maxDuration = 120;

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface PageData {
  bundle: DataBundle;
  validation: ValidationReport;
  computed: ComputedMetrics;
  /** Latest persisted `done` report for this symbol, if any (rendered in full). */
  latestReport: LatestReport | null;
}

async function loadCompany(symbol: string): Promise<PageData> {
  const bundle = await buildDataBundle(symbol);
  const validation = validateBundle(bundle, { now: new Date(bundle.builtAt) });
  const computed = runStageB(bundle);
  // A malformed DB / query never fails the whole page — fall back to no report.
  let latestReport: LatestReport | null = null;
  try {
    latestReport = getLatestDoneReport(symbol);
  } catch {
    latestReport = null;
  }
  return { bundle, validation, computed, latestReport };
}

// ---------------------------------------------------------------------------
// Small render helpers
// ---------------------------------------------------------------------------

function asOfOf<T>(f: { ok: boolean } & Record<string, unknown>): Sourced<T> | null {
  return sourcedOf(f as never);
}

function Stamp({ sourced }: { sourced: Sourced<unknown> | null | undefined }) {
  if (!sourced) return null;
  return <AsOf date={sourced.asOf} stale={sourced.stale} />;
}

function zoneTone(zone: AltmanZone | null): Tone {
  if (zone === "safe") return "pos";
  if (zone === "distress") return "neg";
  if (zone === "grey") return "warn";
  return "muted";
}

function spreadTone(v: number | null): Tone {
  if (v === null) return "muted";
  return v >= 0 ? "pos" : "neg";
}

function NoteList({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-0.5 border-t border-edge pt-2">
      {notes.map((n, i) => (
        <li key={i} className="text-[10px] leading-snug text-faint">
          · {n}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function QuoteHeader({ bundle, computed }: { bundle: DataBundle; computed: ComputedMetrics }) {
  const quote = bundle.quote.ok ? bundle.quote.value.data.rows[0] : undefined;
  const profile = bundle.profile.ok ? bundle.profile.value.data.rows[0] : undefined;
  const quoteSourced = asOfOf(bundle.quote);
  const price = typeof quote?.price === "number" ? quote.price : null;
  const change = typeof quote?.changePercentage === "number" ? quote.changePercentage : null;
  const mktCap = typeof quote?.marketCap === "number" ? quote.marketCap : typeof profile?.marketCap === "number" ? profile.marketCap : null;
  const name = profile?.companyName ?? quote?.name ?? bundle.symbol;
  const exchange = profile?.exchange ?? quote?.exchange ?? "";
  const changeTone: Tone = change === null ? "muted" : change >= 0 ? "pos" : "neg";

  const route = computed.route;

  return (
    <div className="border border-edge bg-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-edge px-3 py-2">
        <div className="flex items-baseline gap-3">
          <span className="mono text-[20px] font-semibold tracking-[0.08em] text-fg">{bundle.symbol}</span>
          <span className="text-[13px] text-muted">{String(name)}</span>
          {exchange ? <span className="mono text-[10px] text-faint">{String(exchange)}</span> : null}
        </div>
        <Stamp sourced={quoteSourced} />
      </div>

      <div className="flex flex-wrap items-stretch divide-x divide-edge">
        <StatCell label="price" value={price === null ? "n/a" : fmtMoney(price)} tone="neutral" />
        <StatCell
          label="change"
          value={change === null ? "n/a" : fmtSignedPct(change)}
          tone={changeTone}
        />
        <StatCell label="mkt cap" value={fmtBig(mktCap)} tone="neutral" />
        <StatCell label="sector" value={profile?.sector ?? "n/a"} tone="muted" />
        <StatCell label="industry" value={profile?.industry ?? "n/a"} tone="muted" />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 border-t border-edge px-3 py-2">
        <Badge tone="accent">route · {route.base}</Badge>
        {route.overlays.map((o) => (
          <Badge key={o} tone="warn">
            {o}
          </Badge>
        ))}
        {quoteSourced?.stale ? <Badge tone="warn">quote stale</Badge> : null}
        {computed.gaps.some((g) => g.severity === "critical") ? (
          <Badge tone="neg">
            {computed.gaps.filter((g) => g.severity === "critical").length} critical gaps
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fundamentals (growth) panel
// ---------------------------------------------------------------------------

interface CagrRow {
  window: string;
  revenue: number | null;
  eps: number | null;
  fcf: number | null;
}

function FundamentalsPanel({
  computed,
  bundle,
  chartData,
}: {
  computed: ComputedMetrics;
  bundle: DataBundle;
  chartData: ReturnType<typeof fundamentalsChartDataFromBundle>;
}) {
  const g = computed.growth;
  const stamp = asOfOf(bundle.statements.incomeAnnual);

  const windows = [1, 3, 5, 10];
  const cagrRows: CagrRow[] = windows.map((w) => ({
    window: `${w}y`,
    revenue: g.revenueCagrs.find((c) => c.windowYears === w)?.cagrPct ?? null,
    eps: g.epsDilutedCagrs.find((c) => c.windowYears === w)?.cagrPct ?? null,
    fcf: g.fcfCagrs.find((c) => c.windowYears === w)?.cagrPct ?? null,
  }));

  const cagrCols: Column<CagrRow>[] = [
    { key: "w", header: "window", render: (r) => <span className="mono text-muted">{r.window}</span> },
    { key: "rev", header: "revenue", align: "right", render: (r) => <span className="mono">{fmtPct(r.revenue)}</span> },
    { key: "eps", header: "eps dil.", align: "right", render: (r) => <span className="mono">{fmtPct(r.eps)}</span> },
    { key: "fcf", header: "fcf", align: "right", render: (r) => <span className="mono">{fmtPct(r.fcf)}</span> },
  ];

  const marginRows = g.margins.gross.series.map((_, i) => {
    const gm = g.margins.gross.series[i];
    return {
      date: gm.date,
      gross: gm.pct,
      operating: g.margins.operating.series[i]?.pct ?? null,
      net: g.margins.net.series[i]?.pct ?? null,
    };
  });
  const marginCols: Column<(typeof marginRows)[number]>[] = [
    { key: "d", header: "fy", render: (r) => <span className="mono text-muted">{r.date.slice(0, 4)}</span> },
    { key: "g", header: "gross", align: "right", render: (r) => <span className="mono">{fmtPct(r.gross)}</span> },
    { key: "o", header: "op", align: "right", render: (r) => <span className="mono">{fmtPct(r.operating)}</span> },
    { key: "n", header: "net", align: "right", render: (r) => <span className="mono">{fmtPct(r.net)}</span> },
  ];

  const accel = g.revenueAcceleration;

  return (
    <Panel title="fundamentals · growth" right={<Stamp sourced={stamp} />}>
      <div className="mb-3">
        <FundamentalsChartGrid data={chartData} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-faint">revenue / eps / fcf CAGR</div>
          <DataTable columns={cagrCols} rows={cagrRows} rowKey={(r) => r.window} />
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="text-faint">rev accel:</span>
            <span className="mono">{fmtPct(accel.latestYoyPct)} yoy</span>
            <span className="text-faint">vs</span>
            <span className="mono">{fmtPct(accel.threeYearCagrPct)} 3y</span>
            {accel.accelerating !== null ? (
              <Badge tone={accel.accelerating ? "pos" : "neg"}>
                {accel.accelerating ? "accelerating" : "decelerating"}
              </Badge>
            ) : null}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-faint">margin trend (oldest→newest)</div>
          <DataTable columns={marginCols} rows={marginRows} rowKey={(r) => r.date} />
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px]">
            <span className="text-faint">
              slope g/o/n:{" "}
              <span className="mono text-fg">
                {fmtNum(g.margins.gross.slopePctPtsPerYear, 2)} / {fmtNum(g.margins.operating.slopePctPtsPerYear, 2)} /{" "}
                {fmtNum(g.margins.net.slopePctPtsPerYear, 2)}
              </span>{" "}
              pp/yr
            </span>
          </div>
        </div>
      </div>
      <NoteList notes={g.notes} />
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Returns panel (ROIC vs WACC)
// ---------------------------------------------------------------------------

function ReturnsPanel({ computed }: { computed: ComputedMetrics }) {
  const r = computed.returns;
  // Latest computable ROIC: prefer the module's latest; if the newest fiscal
  // year lacks a matched balance sheet (data gap), fall back to the most-recent
  // non-null series entry so the panel shows a real figure.
  const roicSeries = r.roic.series;
  const roicLatest =
    r.roic.latestRoicPct ??
    [...roicSeries].reverse().find((y) => y.roicPct !== null)?.roicPct ??
    null;
  const roicAsOf = r.roic.latestRoicPct !== null
    ? r.roic.asOf
    : [...roicSeries].reverse().find((y) => y.roicPct !== null)?.date ?? r.roic.asOf;
  const spreadDisplay =
    r.roicVsWacc.spreadPctPts ??
    (roicLatest !== null && r.wacc.waccPct !== null ? roicLatest - r.wacc.waccPct : null);

  return (
    <Panel title="returns · roic vs wacc">
      <div className="flex flex-wrap items-stretch divide-x divide-edge border border-edge">
        <StatCell
          label="roic (latest)"
          value={fmtPct(roicLatest)}
          delta={roicAsOf ? <span className="text-faint">{roicAsOf.slice(0, 4)}</span> : undefined}
          tone="neutral"
        />
        <StatCell label="wacc" value={fmtPct(r.wacc.waccPct)} tone="neutral" />
        <StatCell
          label="spread"
          value={spreadDisplay === null ? "n/a" : `${spreadDisplay >= 0 ? "+" : ""}${spreadDisplay.toFixed(1)} pp`}
          tone={spreadTone(spreadDisplay)}
        />
        <StatCell label="cost of equity" value={fmtPct(r.wacc.costOfEquityPct)} tone="muted" />
        <StatCell
          label="cost of debt"
          value={fmtPct(r.wacc.costOfDebtPct)}
          delta={<span className="text-faint">{r.wacc.costOfDebtMethod}</span>}
          tone="muted"
        />
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="text-[11px]">
          <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-faint">wacc build</div>
          <dl className="flex flex-col gap-0.5">
            <Row k="beta (raw → final)" v={`${fmtNum(r.wacc.betaRaw, 2)} → ${fmtNum(r.wacc.betaFinal, 2)}`} />
            <Row k="risk-free" v={fmtPct(r.wacc.riskFreePct)} />
            <Row k="ERP" v={fmtPct(r.wacc.erpPct)} />
            <Row k="tax used" v={r.wacc.taxRateUsed === null ? "n/a" : fmtPct(r.wacc.taxRateUsed * 100)} />
            {r.wacc.syntheticRating ? <Row k="synthetic rating" v={r.wacc.syntheticRating} /> : null}
            <Row k="weight E / D" v={`${fmtPct((r.wacc.weightEquity ?? 0) * 100)} / ${fmtPct((r.wacc.weightDebt ?? 0) * 100)}`} />
          </dl>
        </div>
        <div className="text-[11px]">
          <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-faint">dupont (latest FY)</div>
          {r.dupont.latest ? (
            <dl className="flex flex-col gap-0.5">
              <Row k="net margin" v={fmtPct((r.dupont.latest.netMargin ?? 0) * 100)} />
              <Row k="asset turnover" v={fmtNum(r.dupont.latest.assetTurnover, 2)} />
              <Row k="leverage" v={fmtNum(r.dupont.latest.leverage, 2)} />
              <Row k="→ ROE" v={fmtPct(r.dupont.latest.roePct)} />
            </dl>
          ) : (
            <div className="text-faint">DuPont unavailable</div>
          )}
        </div>
      </div>
      <NoteList notes={[...r.wacc.notes.slice(0, 4), r.roicVsWacc.note]} />
    </Panel>
  );
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-faint">{k}</dt>
      <dd className="mono text-fg">{v}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forensics panel
// ---------------------------------------------------------------------------

function ForensicsPanel({ computed }: { computed: ComputedMetrics }) {
  const f = computed.forensics;
  const altman = f.altman;
  const beneish = f.beneish;
  const piotroski = f.piotroski;
  const accruals = f.accruals;

  const beneishTone: Tone =
    beneish?.verdict === "unlikely" ? "pos" : beneish?.verdict === "flag" ? "neg" : beneish?.verdict === "grey" ? "warn" : "muted";
  const accrualTone: Tone =
    accruals?.band === "unremarkable" ? "pos" : accruals?.band === "red" ? "neg" : accruals?.band === "elevated" ? "warn" : "muted";

  return (
    <Panel title="forensics · Z / M / F">
      <div className="flex flex-wrap items-stretch divide-x divide-edge border border-edge">
        <StatCell
          label={`altman ${altman?.variant ?? ""}`.trim()}
          value={altman && altman.score !== null ? fmtNum(altman.score, 2) : "suppressed"}
          delta={
            altman?.zone ? <Badge tone={zoneTone(altman.zone)}>{altman.zone}</Badge> : undefined
          }
          tone={zoneTone(altman?.zone ?? null)}
        />
        <StatCell
          label="beneish M"
          value={beneish && beneish.score !== null ? fmtNum(beneish.score, 2) : "suppressed"}
          delta={beneish?.verdict ? <Badge tone={beneishTone}>{beneish.verdict}</Badge> : undefined}
          tone={beneishTone}
        />
        <StatCell
          label="piotroski F"
          value={piotroski && piotroski.score !== null ? `${piotroski.score} / ${piotroski.outOf}` : "n/a"}
          tone={
            piotroski && piotroski.score !== null
              ? piotroski.score >= 7
                ? "pos"
                : piotroski.score <= 3
                  ? "neg"
                  : "warn"
              : "muted"
          }
        />
        <StatCell
          label="accrual ratio"
          value={accruals && accruals.cashFlowAccrualRatio !== null ? fmtPct(accruals.cashFlowAccrualRatio * 100) : "suppressed"}
          delta={accruals?.band ? <Badge tone={accrualTone}>{accruals.band}</Badge> : undefined}
          tone={accrualTone}
        />
      </div>

      {f.flags.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1.5">
          <div className="text-[10px] uppercase tracking-[0.1em] text-faint">flags</div>
          {f.flags.map((flag) => (
            <div key={flag.id} className="flex items-start gap-2 border border-edge bg-raised px-2 py-1.5">
              <Badge tone={flag.severity === "flag" ? "neg" : flag.severity === "warn" ? "warn" : "muted"}>
                {flag.severity}
              </Badge>
              <span className="text-[11px] leading-snug text-muted">{flag.message}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-3 text-[11px] text-faint">no forensic flags raised.</div>
      )}
      <NoteList notes={f.notes.slice(0, 6)} />
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Technicals panel
// ---------------------------------------------------------------------------

function TechnicalsPanel({
  computed,
  priceProps,
  rsSeries,
}: {
  computed: ComputedMetrics;
  priceProps: ReturnType<typeof priceChartPropsFromBundle>;
  rsSeries: ReturnType<typeof relativeStrengthSeriesFromBundle>;
}) {
  const t = computed.technicals;
  const read = t.read;
  const trendTone: Tone = read.trend === "uptrend" ? "pos" : read.trend === "downtrend" ? "neg" : "muted";
  const momTone: Tone =
    read.momentum === "overbought"
      ? "warn"
      : read.momentum === "oversold"
        ? "warn"
        : read.momentum === "bullish"
          ? "pos"
          : read.momentum === "bearish"
            ? "neg"
            : "muted";

  return (
    <Panel title="technicals · trend & momentum" right={t.asOf ? <AsOf date={t.asOf} /> : null}>
      {priceProps.rows.length > 0 || rsSeries.length > 0 ? (
        <div className="mb-3 border border-edge bg-bg">
          <TechnicalsChartPanel
            bars={priceProps.rows}
            crosses={priceProps.crosses}
            relativeStrength={rsSeries}
          />
        </div>
      ) : null}
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <Badge tone={trendTone}>trend · {read.trend}</Badge>
        <Badge tone={momTone}>momentum · {read.momentum}</Badge>
        <span className="mono text-[11px] text-muted">{read.relativeStrength}</span>
      </div>
      <div className="flex flex-wrap items-stretch divide-x divide-edge border border-edge">
        <StatCell label="last close" value={fmtMoney(t.lastClose)} />
        <StatCell label="sma50 / 200" value={`${fmtNum(t.smaCross.sma50, 1)} / ${fmtNum(t.smaCross.sma200, 1)}`} tone={t.smaCross.state === "golden" ? "pos" : t.smaCross.state === "death" ? "neg" : "muted"} />
        <StatCell label="rsi(14)" value={fmtNum(t.rsi14, 1)} tone={t.rsi14 !== null && t.rsi14 >= 70 ? "warn" : t.rsi14 !== null && t.rsi14 <= 30 ? "warn" : "neutral"} />
        <StatCell label="macd" value={fmtNum(t.macd.histogram, 2)} delta={<span className="text-faint">{t.macd.state}</span>} tone={t.macd.state === "bullish" ? "pos" : t.macd.state === "bearish" ? "neg" : "muted"} />
        <StatCell label="52w range" value={`${fmtNum(t.range52w.low52w, 0)}–${fmtNum(t.range52w.high52w, 0)}`} delta={<span className="text-faint">{fmtPct(t.range52w.positionPct)} pos</span>} />
        <StatCell label="atr%" value={fmtPct(t.atr14.atrPctOfClose)} tone="muted" />
      </div>
      {t.read.flags.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-0.5">
          {t.read.flags.map((fl, i) => (
            <li key={i} className="text-[11px] leading-snug text-muted">
              · {fl}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Valuation panel
// ---------------------------------------------------------------------------

function ValuationPanel({ computed, bundle }: { computed: ComputedMetrics; bundle: DataBundle }) {
  const v = computed.valuation;
  const quote = bundle.quote.ok ? bundle.quote.value.data.rows[0] : undefined;
  const price = typeof quote?.price === "number" ? quote.price : null;

  return (
    <Panel title={`valuation · ${v.route} (${v.kind})`}>
      {v.kind === "dcf" ? <DcfBlock v={v} price={price} /> : null}
      {v.kind === "excess-return" ? <ExcessReturnBlock v={v} price={price} /> : null}
      {v.kind === "reit" ? <ReitBlock v={v} /> : null}
      {v.kind === "pre-revenue" ? (
        <div className="text-[11px] text-muted">
          Pre-revenue company — no intrinsic-value model in v1. See runway below.
        </div>
      ) : null}
      {v.kind === "dcf-suppressed" ? (
        <div className="text-[11px] text-muted">
          DCF suppressed — unprofitable overlay: free cash flow is structurally negative, making an FCFF-based
          intrinsic-value model unreliable. See multiples below for relative valuation; cash-runway/burn framing
          appears elsewhere in this report.
        </div>
      ) : null}

      {"multiples" in v && v.multiples ? <MultiplesBlock multiples={v.multiples} /> : null}
      <NoteList notes={v.notes.slice(0, 5)} />
    </Panel>
  );
}

function DcfBlock({
  v,
  price,
}: {
  v: Extract<ComputedMetrics["valuation"], { kind: "dcf" }>;
  price: number | null;
}) {
  const perShare = v.dcf?.perShare ?? null;
  const up = upsidePct(perShare, price);
  const reverse = v.reverseDcf;

  return (
    <div>
      <div className="flex flex-wrap items-stretch divide-x divide-edge border border-edge">
        <StatCell label="dcf / share" value={fmtMoney(perShare)} tone="accent" />
        <StatCell label="vs price" value={up === null ? "n/a" : fmtSignedPct(up)} tone={up === null ? "muted" : up >= 0 ? "pos" : "neg"} />
        <StatCell label="terminal %" value={v.dcf ? fmtPct(v.dcf.gTermUsedPct) : "n/a"} tone="muted" />
        <StatCell label="terminal share" value={v.dcf && v.dcf.terminalShare !== null ? fmtPct(v.dcf.terminalShare * 100) : "n/a"} tone="muted" />
      </div>

      {reverse && reverse.method !== "none" ? (
        <div className="mt-2 text-[11px] text-muted">
          <span className="text-faint">reverse DCF:</span>{" "}
          {reverse.method === "growth"
            ? `market price implies ${fmtPct(reverse.impliedRevenueGrowthPct)} revenue CAGR`
            : `market price implies ${fmtPct(reverse.impliedTerminalMarginPct)} terminal EBIT margin`}
        </div>
      ) : null}

      {v.assumptions ? <AssumptionTable a={v.assumptions} /> : null}
      {v.sensitivity ? <SensitivityGridTable grid={v.sensitivity} /> : null}
    </div>
  );
}

function AssumptionTable({ a }: { a: NonNullable<Extract<ComputedMetrics["valuation"], { kind: "dcf" }>["assumptions"]> }) {
  const rows = [
    { k: "start revenue", val: fmtBig(a.startRevenue.value), basis: a.startRevenue.basis },
    { k: "growth y1 / yN", val: `${fmtPct(a.growthPath.value[0])} → ${fmtPct(a.growthPath.value[a.growthPath.value.length - 1])}`, basis: a.growthPath.basis },
    { k: "ebit margin y1 / yN", val: `${fmtPct(a.ebitMarginPath.value[0])} → ${fmtPct(a.ebitMarginPath.value[a.ebitMarginPath.value.length - 1])}`, basis: a.ebitMarginPath.basis },
    { k: "sales-to-capital", val: fmtNum(a.salesToCapital.value, 2), basis: a.salesToCapital.basis },
    { k: "terminal growth", val: fmtPct(a.terminal.gTermPct.value), basis: a.terminal.gTermPct.basis },
    { k: "terminal ROIC", val: fmtPct(a.terminal.roicTermPct.value), basis: a.terminal.roicTermPct.basis },
  ];
  const cols: Column<(typeof rows)[number]>[] = [
    { key: "k", header: "assumption", render: (r) => <span className="text-muted">{r.k}</span> },
    { key: "v", header: "value", align: "right", render: (r) => <span className="mono">{r.val}</span> },
    { key: "b", header: "basis", render: (r) => <span className="text-[10px] text-faint">{r.basis}</span> },
  ];
  return (
    <div className="mt-3">
      <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-faint">assumptions</div>
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.k} />
    </div>
  );
}

function SensitivityGridTable({ grid }: { grid: NonNullable<Extract<ComputedMetrics["valuation"], { kind: "dcf" }>["sensitivity"]> }) {
  // Flatten the (WACC × g) matrix into the shared SensitivityHeatmap's cell list,
  // so the company page, report view, and sample route all render one heatmap.
  const cells: SensitivityCell[] = [];
  grid.waccPcts.forEach((w, i) => {
    grid.gTermPcts.forEach((g, j) => {
      cells.push({ waccPct: w, gTermPct: g, perShare: grid.perShare[i]?.[j] ?? null });
    });
  });
  const baseWacc = grid.waccPcts[Math.floor(grid.waccPcts.length / 2)] ?? null;
  const baseG = grid.gTermPcts[Math.floor(grid.gTermPcts.length / 2)] ?? null;
  return (
    <div className="mt-3">
      <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-faint">
        sensitivity · per share (rows = WACC %, cols = terminal g %)
      </div>
      <SensitivityHeatmap cells={cells} baseWacc={baseWacc} baseG={baseG} />
    </div>
  );
}

function ExcessReturnBlock({
  v,
  price,
}: {
  v: Extract<ComputedMetrics["valuation"], { kind: "excess-return" }>;
  price: number | null;
}) {
  const er = v.excessReturn;
  const up = upsidePct(er.perShare, price);
  return (
    <div className="flex flex-wrap items-stretch divide-x divide-edge border border-edge">
      <StatCell label="value / share" value={fmtMoney(er.perShare)} tone="accent" />
      <StatCell label="vs price" value={up === null ? "n/a" : fmtSignedPct(up)} tone={up === null ? "muted" : up >= 0 ? "pos" : "neg"} />
      <StatCell label="implied P/BV" value={fmtX(er.impliedPToBv)} tone="muted" />
      <StatCell
        label="reverse steady ROE"
        value={fmtPct(er.reverseSolve.impliedSteadyRoePct)}
        tone="muted"
      />
    </div>
  );
}

function ReitBlock({ v }: { v: Extract<ComputedMetrics["valuation"], { kind: "reit" }> }) {
  const r = v.reit;
  return (
    <div className="flex flex-wrap items-stretch divide-x divide-edge border border-edge">
      <StatCell label="P / FFO" value={fmtX(r.pToFfo)} tone="accent" />
      <StatCell label="P / AFFO" value={fmtX(r.pToAffo)} tone="accent" />
      <StatCell label="FFO / share" value={fmtMoney(r.ffoPerShare)} tone="muted" />
      <StatCell label="implied cap rate" value={fmtPct(r.impliedCapRatePct)} tone="muted" />
    </div>
  );
}

function MultiplesBlock({ multiples }: { multiples: NonNullable<Extract<ComputedMetrics["valuation"], { kind: "dcf" }>["multiples"]> }) {
  const rows = multiples.multiples.filter((m) => multiples.sectorAppropriate.includes(m.key));
  const cols: Column<(typeof rows)[number]>[] = [
    { key: "k", header: "multiple", render: (m) => <span className="mono text-muted">{m.key}</span> },
    { key: "cur", header: "current", align: "right", render: (m) => <span className="mono">{fmtX(m.current)}</span> },
    {
      key: "hist",
      header: "own p50",
      align: "right",
      render: (m) => <span className="mono text-muted">{m.ownHistory ? fmtX(m.ownHistory.p50) : "n/a"}</span>,
    },
    {
      key: "peer",
      header: "peer median",
      align: "right",
      render: (m) => <span className="mono text-muted">{m.peers ? fmtX(m.peers.median) : "n/a"}</span>,
    },
  ];
  return (
    <div className="mt-3">
      <div className="mb-1 text-[10px] uppercase tracking-[0.1em] text-faint">sector-appropriate multiples</div>
      <DataTable columns={cols} rows={rows} rowKey={(m) => m.key} empty="no multiples derivable" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Runway panel (overlay-gated)
// ---------------------------------------------------------------------------

function RunwayPanel({ computed }: { computed: ComputedMetrics }) {
  const rw = computed.runway;
  if (!rw) return null;
  return (
    <Panel title="runway · burn & liquidity" right={rw.liquidAssetsAsOf ? <AsOf date={rw.liquidAssetsAsOf} /> : null}>
      <div className="flex flex-wrap items-stretch divide-x divide-edge border border-edge">
        <StatCell label="burning?" value={rw.burning === null ? "unknown" : rw.burning ? "yes" : "no"} tone={rw.burning ? "warn" : "pos"} />
        <StatCell label="liquid assets" value={fmtBig(rw.liquidAssets)} />
        <StatCell label="avg qtr burn" value={fmtBig(rw.avgQuarterlyBurn)} tone="muted" />
        <StatCell label="runway" value={rw.runwayQuarters === null ? "n/a" : `${rw.runwayQuarters.toFixed(1)} Q`} tone={rw.runwayQuarters !== null && rw.runwayQuarters < 4 ? "neg" : "neutral"} />
        <StatCell label="exhaustion" value={rw.estimatedExhaustionDate ?? "n/a"} tone="muted" />
      </div>
      {rw.dilution ? (
        <div className="mt-2 text-[11px] text-muted">
          <span className="text-faint">2y dilution:</span> {fmtSignedPct(rw.dilution.totalGrowth * 100)} total ·{" "}
          {fmtSignedPct(rw.dilution.annualizedGrowth * 100)}/yr
        </div>
      ) : null}
      <NoteList notes={rw.notes.slice(0, 4)} />
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Validation & gaps panel
// ---------------------------------------------------------------------------

function ValidationPanel({ computed, validation, bundle }: { computed: ComputedMetrics; validation: ValidationReport; bundle: DataBundle }) {
  const summary = renderManifestSummary(computed.gaps);
  const xbrl = bundle.edgar.xbrlSummary;

  const checkCols: Column<ValidationReport["checks"][number]>[] = [
    {
      key: "s",
      header: "",
      render: (c) => (
        <Badge tone={c.status === "pass" ? "pos" : c.status === "fail" ? "neg" : c.status === "warn" ? "warn" : "muted"}>{c.status}</Badge>
      ),
    },
    { key: "name", header: "check", render: (c) => <span className="text-muted">{c.name}</span> },
    { key: "detail", header: "detail", render: (c) => <span className="text-[10px] text-faint">{c.detail}</span> },
    {
      key: "delta",
      header: "Δ%",
      align: "right",
      render: (c) => <span className="mono">{c.deltaPct === undefined ? "" : `${c.deltaPct.toFixed(4)}%`}</span>,
    },
  ];

  // Sort gaps critical → warn → info (already severity-ordered by mergeManifest).
  const gaps = computed.gaps;

  return (
    <Panel
      title="validation & missing-data manifest"
      right={<span className="mono text-[11px] text-muted">{summary.line}</span>}
    >
      {xbrl ? (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
          <Badge tone="accent">XBRL</Badge>
          <span className="text-muted">{xbrl.entityName}</span>
          <span className="text-faint">
            {xbrl.usGaapTagCount} us-gaap tags · latest fact {xbrl.latestFactEnd ?? "n/a"}
            {xbrl.bankTagging ? " · bank tagging" : ""}
          </span>
        </div>
      ) : null}

      <DataTable columns={checkCols} rows={validation.checks} rowKey={(c) => c.id} empty="no checks run" />

      {validation.flags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {validation.flags.map((fl, i) => (
            <Badge key={i} tone="warn">
              {fl}
            </Badge>
          ))}
        </div>
      ) : null}

      <div className="mt-3 flex flex-col gap-1.5">
        <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.1em] text-faint">
          <span>gaps ({gaps.length})</span>
          <span>
            {summary.bySeverity.critical} crit · {summary.bySeverity.warn} warn · {summary.bySeverity.info} info
          </span>
        </div>
        {gaps.length === 0 ? (
          <div className="text-[11px] text-faint">no gaps — full data coverage.</div>
        ) : (
          gaps.slice(0, 40).map((g: ManifestEntry, i) => <GapNotice key={`${g.field}-${i}`} entry={g} />)
        )}
        {gaps.length > 40 ? (
          <div className="text-[10px] text-faint">…and {gaps.length - 40} more.</div>
        ) : null}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Error surface
// ---------------------------------------------------------------------------

function UnknownTicker({ symbol, gap }: { symbol: string; gap: ManifestEntry | null }) {
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3 p-6">
      <div className="border border-warn/40 bg-warn/10 px-4 py-3">
        <div className="mono text-[14px] font-semibold text-warn">ticker not found: {symbol}</div>
        <p className="mt-1 text-[12px] text-muted">
          No company profile resolved for <span className="mono">{symbol}</span>. It may be an invalid ticker, a
          delisted symbol, or (in fixture mode) a symbol without a bundled fixture.
        </p>
        {gap ? (
          <p className="mt-2 text-[11px] text-faint">
            <span className="mono">{gap.field}</span> — {gap.reason}
          </p>
        ) : null}
      </div>
      <Link href="/company/DEMO" className="text-[12px] text-accent hover:underline">
        → try DEMO
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function CompanyPage({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol: rawSymbol } = await params;
  let decodedSymbol: string;
  try {
    decodedSymbol = decodeURIComponent(rawSymbol);
  } catch {
    notFound();
  }
  const symbol = decodedSymbol!.toUpperCase().trim();
  if (!isValidSymbol(symbol)) notFound();

  // Render the shell + sidebar immediately and STREAM the heavy pipeline body in
  // behind a Suspense boundary, so navigating to a ticker paints instantly
  // instead of blocking on the full Stage-A fetch + Stage-B compute. loading.tsx
  // covers the initial route transition; this covers everything after it.
  return (
    <AppShell
      sidebar={
        <Suspense fallback={<SidebarSkeleton />}>
          <WatchlistSidebar activeSymbol={symbol} />
        </Suspense>
      }
    >
      <Suspense fallback={<CompanyBodySkeleton symbol={symbol} />}>
        <CompanyBody symbol={symbol} />
      </Suspense>
    </AppShell>
  );
}

/**
 * The heavy research surface for one symbol. Runs the full pipeline
 * (loadCompany → buildDataBundle + validate + runStageB) and renders the panels.
 * Rendered inside CompanyPage's <Suspense> boundary so its await streams instead
 * of blocking the whole route — the fix for the "rendering…" stall.
 */
async function CompanyBody({ symbol }: { symbol: string }) {
  let data: PageData;
  try {
    data = await loadCompany(symbol);
  } catch (err) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="border border-neg/40 bg-neg/10 px-4 py-3 text-[12px] text-neg">
          <div className="mono font-semibold">pipeline error for {symbol}</div>
          <p className="mt-1 text-muted">{err instanceof Error ? err.message : String(err)}</p>
        </div>
      </div>
    );
  }

  const { bundle, validation, computed } = data;

  // Unknown ticker: no profile row resolved.
  const profileRow = bundle.profile.ok ? bundle.profile.value.data.rows[0] : undefined;
  if (!profileRow || (!profileRow.companyName && !profileRow.symbol)) {
    const gap = bundle.profile.ok ? null : bundle.profile.gap;
    return <UnknownTicker symbol={symbol} gap={gap} />;
  }

  // Build the heavy (~1260-bar) chart datasets ONCE and thread them through both
  // the analysis panels and the ReportView charts (both tab trees render on this
  // request) instead of rebuilding each 2–3× across the tree.
  const priceProps = priceChartPropsFromBundle(bundle, computed);
  const rsSeries = relativeStrengthSeriesFromBundle(bundle);
  const fundData = fundamentalsChartDataFromBundle(bundle, computed);

  // Stage-B live analysis panels (always available from the just-run pipeline).
  const analysisPanels = (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <FundamentalsPanel computed={computed} bundle={bundle} chartData={fundData} />
        <ReturnsPanel computed={computed} />
        <ForensicsPanel computed={computed} />
        <TechnicalsPanel computed={computed} priceProps={priceProps} rsSeries={rsSeries} />
      </div>

      <ValuationPanel computed={computed} bundle={bundle} />
      <RunwayPanel computed={computed} />
      <ValidationPanel computed={computed} validation={validation} bundle={bundle} />
    </div>
  );

  // When a persisted report exists, render the full ReportView (with live charts)
  // behind a tab, defaulting to the report; otherwise show the analysis directly.
  const hasReport = data.latestReport?.report != null;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-[11px] text-faint">
            built {new Date(bundle.builtAt).toISOString().replace("T", " ").slice(0, 19)}Z
          </div>
          <div className="flex items-center gap-2">
            {hasReport && data.latestReport ? (
              <ExportButtons
                reportId={data.latestReport.reportId}
                symbol={bundle.symbol}
              />
            ) : null}
            <Link
              href={`/company/${encodeURIComponent(bundle.symbol)}/history`}
              className="mono border border-edge-strong px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-muted transition-colors hover:border-accent hover:text-accent"
              title="report history, compare, and export"
            >
              history
            </Link>
          </div>
        </div>

        <GenerateReport symbol={bundle.symbol} />

        <QuoteHeader bundle={bundle} computed={computed} />

        {hasReport && data.latestReport ? (
          <ReportTabs
            reportMeta={`#${data.latestReport.reportId} · ${data.latestReport.createdAt.slice(0, 10)}`}
            report={
              <ReportView
                report={data.latestReport.report as NonNullable<LatestReport["report"]>}
                technicalsChart={
                  <TechnicalsChartPanel
                    bars={priceProps.rows}
                    crosses={priceProps.crosses}
                    relativeStrength={rsSeries}
                  />
                }
                fundamentalsChart={
                  <div className="p-3">
                    <FundamentalsChartGrid data={fundData} />
                  </div>
                }
              />
            }
            analysis={analysisPanels}
          />
        ) : (
          analysisPanels
        )}
    </div>
  );
}
