import { describe, expect, it } from "vitest";
import { parseUiDesign, persistUiDesign, type CookieDocument } from "@/appearance/preference";

class CookieJar implements CookieDocument {
  private values = new Map<string, string>([["unrelated", "keep"]]);
  writes: string[] = [];
  get cookie() { return [...this.values].map(([key, value]) => `${key}=${value}`).join("; "); }
  set cookie(value: string) {
    this.writes.push(value);
    const pair = value.split(";")[0]!;
    const index = pair.indexOf("=");
    this.values.set(pair.slice(0, index), pair.slice(index + 1));
  }
}

describe("browser appearance preference", () => {
  it.each([undefined, null, "", "other", "WORKSPACE", " workspace ", "workspace; model=paid", {}])(
    "defaults missing or malformed value %j to the current design", (value) => {
      expect(parseUiDesign(value)).toBe("current");
    },
  );

  it("accepts the exact workspace value from a server cookie", () => {
    expect(parseUiDesign("workspace")).toBe("workspace");
    expect(parseUiDesign("current")).toBe("current");
  });

  it("persists one scoped preference and restores either design without touching other cookies", () => {
    const jar = new CookieJar();
    expect(persistUiDesign("workspace", jar, false)).toBe(true);
    expect(jar.cookie).toBe("unrelated=keep; thesis-ui-design=workspace");
    expect(jar.writes[0]).toBe("thesis-ui-design=workspace; Path=/; Max-Age=15552000; SameSite=Lax");
    expect(persistUiDesign("current", jar, true)).toBe(true);
    expect(jar.cookie).toBe("unrelated=keep; thesis-ui-design=current");
    expect(jar.writes[1]).toContain("; Secure");
  });

  it("reports a silently blocked browser write rather than claiming persistence", () => {
    const blocked = { get cookie() { return "unrelated=keep"; }, set cookie(_value: string) {} };
    expect(persistUiDesign("workspace", blocked, false)).toBe(false);
    // Default parsing is not sufficient to confirm a Current write either.
    expect(persistUiDesign("current", blocked, false)).toBe(false);
  });

  it("reports unavailable cookie access without leaking browser exception details", () => {
    const blocked = { get cookie(): string { throw new Error("private browser details"); },
      set cookie(_value: string) { throw new Error("private browser details"); } };
    expect(persistUiDesign("workspace", blocked, true)).toBe(false);
  });
});
