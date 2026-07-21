import Link from "next/link";
import { getConfig } from "@/config/env";
import { AppShell } from "@/components/shell";
import { Badge, GradeChip, Panel } from "@/components/ui";
import { WatchlistSidebar } from "@/components/watchlist/Sidebar";
import {
  getWatchlistView,
  type WatchlistRowView,
  type WatchlistGrades,
} from "@/watchlist/watchlist";
import { AddTicker } from "@/components/watchlist/AddTicker";

// Key presence is read from process.env at request time — never bake it into
// the build output. The dashboard also loads the watchlist view (DB + network).
export const dynamic = "force-dynamic";

function KeyRow({
  name,
  configured,
  detail,
}: {
  name: string;
  configured: boolean;
  detail: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-edge py-1.5 last:border-b-0">
      <div className="min-w-0">
        <div className="mono text-[12px] text-fg">{name}</div>
        <div className="truncate text-[11px] text-faint">{detail}</div>
      </div>
      {configured ? (
        <Badge tone="pos">configured</Badge>
      ) : (
        <Badge tone="neg">missing</Badge>
      )}
    </div>
  );
}

function KeylessRow({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-edge py-1.5 last:border-b-0">
      <div className="min-w-0">
        <div className="mono text-[12px] text-fg">{name}</div>
        <div className="truncate text-[11px] text-faint">{detail}</div>
      </div>
      <Badge tone="accent">live · keyless</Badge>
    </div>
  );
}

/* ------------------------------------------------------------------------ *
 * Home watchlist panel — the same enriched view the sidebar renders, but as a
 * prominent dashboard card with a wider 6-grade strip and a quick add control.
 * ------------------------------------------------------------------------ */

const HOME_GRADE_ORDER: ReadonlyArray<{ key: keyof WatchlistGrades; label: string }> = [
  { key: "fundamentals", label: "F" },
  { key: "valuation", label: "V" },
  { key: "technicals", label: "T" },
  { key: "quality", label: "Q" },
  { key: "leadership", label: "L" },
  { key: "moat", label: "M" },
];

function fmtPrice(v: number): string {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function HomeGradeStrip({ grades }: { grades: WatchlistGrades | null | undefined }) {
  if (!grades) {
    return <span className="mono text-[10px] text-faint">no report</span>;
  }
  return (
    <div className="flex items-center gap-1" aria-label="section grades">
      {HOME_GRADE_ORDER.map(({ key, label }) => (
        <span key={key} className="flex flex-col items-center gap-px" title={`${label}: ${grades[key]}`}>
          <span className="text-[7px] leading-none text-faint">{label}</span>
          <GradeChip grade={grades[key]} />
        </span>
      ))}
    </div>
  );
}

function HomeWatchRow({ row }: { row: WatchlistRowView }) {
  const price = typeof row.price === "number" ? row.price : null;
  const change = typeof row.changePct === "number" ? row.changePct : null;
  const changeTone =
    change === null ? "text-faint" : change >= 0 ? "text-pos" : "text-neg";
  return (
    <Link
      href={`/company/${encodeURIComponent(row.symbol)}`}
      className="flex items-center justify-between gap-3 border-b border-edge px-3 py-2 last:border-b-0 hover:bg-raised"
    >
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="mono text-[13px] font-semibold tracking-[0.06em] text-fg">
          {row.symbol}
        </span>
        {row.companyName ? (
          <span className="truncate text-[11px] text-faint">{row.companyName}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <HomeGradeStrip grades={row.grades} />
        <div className="flex flex-col items-end">
          <span className="mono text-[12px] text-fg">
            {price === null ? "—" : fmtPrice(price)}
          </span>
          {change !== null ? (
            <span className={`mono text-[10px] ${changeTone}`}>
              {change >= 0 ? "+" : ""}
              {change.toFixed(2)}%
            </span>
          ) : null}
        </div>
        <span className="mono text-[16px] leading-none text-faint">→</span>
      </div>
    </Link>
  );
}

async function HomeWatchlistPanel({ fixtureMode }: { fixtureMode: boolean }) {
  let rows: WatchlistRowView[] = [];
  try {
    rows = await getWatchlistView();
  } catch {
    rows = [];
  }
  return (
    <Panel
      title="watchlist"
      right={
        <span className="mono text-[10px] text-faint">
          {rows.length} {rows.length === 1 ? "ticker" : "tickers"}
        </span>
      }
    >
      <div className="mb-2">
        <AddTicker />
      </div>
      {rows.length === 0 ? (
        <p className="px-1 py-3 text-[12px] text-muted">
          No tickers yet. Add one above, or{" "}
          <Link
            href={fixtureMode ? "/company/DEMO" : "/company/AAPL"}
            className="text-accent hover:underline"
          >
            start with {fixtureMode ? "DEMO" : "AAPL"} →
          </Link>
        </p>
      ) : (
        <div className="border border-edge bg-bg">
          {rows.map((row) => (
            <HomeWatchRow key={row.symbol} row={row} />
          ))}
        </div>
      )}
    </Panel>
  );
}

export default async function Home() {
  const config = getConfig();

  return (
    <AppShell sidebar={<WatchlistSidebar />}>
      <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
        {config.fixtureMode && (
          <div className="border border-warn/40 bg-warn/10 px-3 py-2 text-[12px] text-warn">
            <span className="mono font-semibold uppercase tracking-[0.08em]">
              synthetic fixture mode
            </span>{" "}
            — no FMP_API_KEY configured. No current market data is shown. Try the
            fictional general-company ticker{" "}
            <Link href="/company/DEMO" className="font-semibold underline">
              DEMO
            </Link>{" "}
            or fictional bank ticker <span className="mono font-semibold">DBNK</span>;
            unsupported symbols become disclosed gaps. Add a key to{" "}
            <span className="mono">.env</span> and restart for live provider data.
          </div>
        )}

        <HomeWatchlistPanel fixtureMode={config.fixtureMode} />

        <Panel
          title="build status"
          right={
            <Link href="/settings" className="text-accent hover:underline">
              settings →
            </Link>
          }
        >
          <div className="flex flex-col">
            <KeyRow
              name="FMP_API_KEY"
              configured={config.hasFmpKey}
              detail="primary fundamentals + market data (FMP Ultimate)"
            />
            <KeyRow
              name="FINNHUB_API_KEY"
              configured={config.hasFinnhubKey}
              detail="insider sentiment (MSPR)"
            />
            <KeyRow
              name="FRED_API_KEY"
              configured={config.hasFredKey}
              detail="macro series (falls back to keyless fredgraph.csv in dev)"
            />
            <KeyRow
              name="ANTHROPIC_API_KEY"
              configured={config.hasAnthropicKey}
              detail="analysis passes + web search"
            />
          </div>
        </Panel>

        <Panel title="keyless sources">
          <div className="flex flex-col">
            <KeylessRow
              name="SEC EDGAR"
              detail="filings, XBRL cross-check, 10-K/10-Q extraction"
            />
            <KeylessRow
              name="FINRA"
              detail="short interest + days to cover"
            />
          </div>
        </Panel>

        <Panel title="models">
          <div className="flex flex-col gap-1 text-[12px]">
            <div className="flex items-center justify-between">
              <span className="text-muted">analysis model (env default)</span>
              <span className="mono">{config.analysisModel}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted">verification</span>
              <span className="mono">deterministic (no model)</span>
            </div>
            <div className="pt-1 text-[11px] text-faint">
              Override on the{" "}
              <Link href="/settings" className="text-accent hover:underline">
                settings page
              </Link>
              .
            </div>
          </div>
        </Panel>
      </div>
    </AppShell>
  );
}
