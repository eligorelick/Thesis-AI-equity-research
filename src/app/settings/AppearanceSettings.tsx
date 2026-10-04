"use client";

import { useUiDesign } from "@/appearance/UiDesignProvider";
import type { UiDesign } from "@/appearance/preference";
import { Panel } from "@/components/ui";

export function AppearanceSettingsView({ design, saved, onChange }: {
  design: UiDesign;
  saved: boolean | null;
  onChange(design: UiDesign): void;
}) {
  return (
    <Panel title="appearance">
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Interface design</legend>
        {([
          ["current", "Current", "Compact dark interface."],
          ["workspace", "Research workspace", "Light reading surface, evidence rail and responsive navigation."],
        ] as const).map(([value, label, description]) => (
          <label key={value} className="flex cursor-pointer items-start gap-2 border border-edge bg-bg p-2 text-[12px]">
            <input type="radio" name="uiDesign" value={value} checked={design === value}
              onChange={() => onChange(value)} className="mt-1 accent-[var(--accent)]" />
            <span><span className="block font-medium">{label}</span><span className="block text-faint">{description}</span></span>
          </label>
        ))}
      </fieldset>
      <p className="mt-2 text-[11px] text-faint">Applies immediately in this browser. Report content and AI settings stay the same.</p>
      <p role="status" aria-live="polite" className={`mt-1 text-[11px] ${saved === false ? "text-warn" : "text-muted"}`}>
        {saved === true ? "Applied and saved in this browser." : saved === false
          ? "Applied for this visit. Your browser blocked saving the preference; reload may restore the previous design."
          : "Current is the default. The preference is stored in a browser cookie for 180 days."}
      </p>
    </Panel>
  );
}

export function AppearanceSettings() {
  const { design, saved, chooseDesign } = useUiDesign();
  return <AppearanceSettingsView design={design} saved={saved} onChange={chooseDesign} />;
}
