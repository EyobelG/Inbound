import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Inbound — Transit-aware dates in Boston",
  description:
    "Meet in the middle. Curated two-stop date itineraries mapped to the MBTA, with crowdsourced noise, lighting, and date-stage metrics.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
