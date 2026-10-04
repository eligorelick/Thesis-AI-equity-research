import type { UiDesign } from "@/appearance/preference";

const PALETTES = {
  current: { bgPanel: "#0f141c", bgRaised: "#151c26", border: "#1f2937", borderStrong: "#2b3648",
    fg: "#d5dce6", fgMuted: "#8494a8", fgFaint: "#7f8fa4", accent: "#3ba7f5",
    pos: "#2ecc8f", neg: "#f0525f", warn: "#e8b339", sma50: "#3ba7f5", sma200: "#e8b339", volume: "#2b3648" },
  workspace: { bgPanel: "#ffffff", bgRaised: "#f2f7f8", border: "#bacbd3", borderStrong: "#819ca7",
    fg: "#17333d", fgMuted: "#526770", fgFaint: "#526770", accent: "#0b6671",
    pos: "#17624b", neg: "#a23642", warn: "#896000", sma50: "#0b6671", sma200: "#896000", volume: "#819ca7" },
} as const;

export type ChartPalette = { [Key in keyof typeof PALETTES.current]: string };
/** Canvas charts require resolved colors, whereas SVG can inherit CSS tokens. */
export function chartPalette(design: UiDesign = "current"): ChartPalette { return PALETTES[design]; }

export const SVG_CHART_THEME = {
  bgRaised: "var(--bg-raised)", border: "var(--border)", borderStrong: "var(--border-strong)",
  fg: "var(--fg)", fgMuted: "var(--fg-muted)", fgFaint: "var(--fg-faint)",
  accent: "var(--accent)", pos: "var(--pos)", neg: "var(--neg)", warn: "var(--warn)",
} as const;
