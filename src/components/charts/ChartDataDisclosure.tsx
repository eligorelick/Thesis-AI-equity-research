"use client";

import { useState } from "react";

export interface ChartDataRow { date: string; values: readonly (number | null)[] }
interface TableProps {
  columns: readonly string[];
  rows: readonly ChartDataRow[];
  caption: string;
  page: number;
  pageSize?: number;
  onPageChange: (page: number) => void;
}

/** Pure view: page zero is the newest observations, ascending within each page. */
export function ChartDataTable({ columns, rows, caption, page, pageSize = 30, onPageChange }: TableProps) {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.max(0, Math.min(page, pages - 1));
  const end = rows.length - current * pageSize;
  const start = Math.max(0, end - pageSize);
  const visible = rows.slice(start, end);
  if (!rows.length) return <p className="text-[11px] text-faint">No usable observations available.</p>;
  return <div className="flex min-w-0 flex-col gap-2">
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
      <span>Rows {start + 1}–{end} of {rows.length} · {visible[0]!.date} to {visible.at(-1)!.date}</span>
      <button type="button" className="border border-edge px-2 py-1 disabled:opacity-50" disabled={current >= pages - 1} onClick={() => onPageChange(current + 1)}>Older</button>
      <button type="button" className="border border-edge px-2 py-1 disabled:opacity-50" disabled={current === 0} onClick={() => onPageChange(current - 1)}>Newer</button>
    </div>
    <div className="max-w-full overflow-x-auto" role="region" aria-label={`${caption} table; scroll horizontally for all columns`} tabIndex={0}>
      <table className="w-full border-collapse text-[11px]">
        <caption className="pb-1 text-left text-faint">{caption}</caption>
        <thead><tr className="border-b border-edge-strong"><th scope="col" className="px-2 py-1 text-left text-muted">Date</th>
          {columns.map((column, i) => <th scope="col" key={i} className="whitespace-nowrap px-2 py-1 text-right text-muted">{column}</th>)}</tr></thead>
        <tbody>{visible.map((row) => <tr key={row.date} className="border-b border-edge">
          <th scope="row" className="mono whitespace-nowrap px-2 py-1 text-left font-normal text-muted">{row.date}</th>
          {row.values.map((value, i) => <td key={i} className="mono whitespace-nowrap px-2 py-1 text-right text-fg">{value === null ? "unavailable" : String(value)}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}

/** Native keyboard toggle; closed disclosures add no table rows to the initial DOM. */
export function ChartDataDisclosure({ label, columns, rows, caption, basis }: Omit<TableProps, "page" | "onPageChange" | "pageSize"> & { label: string; basis: string }) {
  const [open, setOpen] = useState(false);
  // Reset pagination when the actual observations change, without effect-delayed stale rows.
  const [position, setPosition] = useState({ rows, page: 0 });
  const page = position.rows === rows ? position.page : 0;
  return <details className="min-w-0 border-t border-edge px-1 py-2" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-[11px] text-muted hover:text-accent">{label}</summary>
    {rows.length === 0 ? <p className="mt-2 text-[11px] text-faint">No usable observations available.</p> : null}
    {open && <div className="mt-2 flex min-w-0 flex-col gap-2">
      <p className="text-[11px] text-faint">{basis}</p>
      <ChartDataTable columns={columns} rows={rows} caption={caption} page={page} onPageChange={(next) => setPosition({ rows, page: next })} />
    </div>}
  </details>;
}
