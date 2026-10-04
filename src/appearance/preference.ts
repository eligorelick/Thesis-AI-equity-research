/** A nonsecret, per-browser display preference; independent of research settings. */
export type UiDesign = "current" | "workspace";
export const UI_DESIGN_COOKIE = "thesis-ui-design";
export const UI_DESIGN_MAX_AGE = 180 * 24 * 60 * 60;

export function parseUiDesign(value: unknown): UiDesign {
  return value === "workspace" ? "workspace" : "current";
}

export interface CookieDocument { cookie: string }

export function persistUiDesign(design: UiDesign, storage: CookieDocument, secure: boolean): boolean {
  const value = parseUiDesign(design);
  try {
    storage.cookie = `${UI_DESIGN_COOKIE}=${value}; Path=/; Max-Age=${UI_DESIGN_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;
    // Browsers can ignore a cookie assignment without throwing. Confirm the
    // exact stored pair; absent Current is a default, not a successful write.
    return storage.cookie.split(";").some((pair) => pair.trim() === `${UI_DESIGN_COOKIE}=${value}`);
  } catch {
    return false;
  }
}
