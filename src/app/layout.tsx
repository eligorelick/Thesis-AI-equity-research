import type { Metadata } from "next";
import { cookies } from "next/headers";
import { parseUiDesign, UI_DESIGN_COOKIE } from "@/appearance/preference";
import { UiDesignProvider } from "@/appearance/UiDesignProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Thesis",
  description:
    "Local-first equity research engine. Informational only, not investment advice.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const design = parseUiDesign((await cookies()).get(UI_DESIGN_COOKIE)?.value);
  return (
    <html lang="en">
      <body data-ui-design={design} className="min-h-screen bg-bg text-fg antialiased">
        <UiDesignProvider initialDesign={design}>{children}</UiDesignProvider>
      </body>
    </html>
  );
}
