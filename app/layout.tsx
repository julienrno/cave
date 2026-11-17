import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

// Geist and Geist Mono (OFL), self-hosted
const plain = localFont({ src: "./fonts/Geist-Variable.woff2", weight: "100 900", variable: "--font-plain", display: "swap" });
const mono = localFont({ src: "./fonts/GeistMono-Variable.woff2", weight: "100 900", variable: "--font-mono", display: "swap" });

// The live address on Vercel (it follows the project's production domain); localhost when running locally
const SITE = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "http://localhost:3000";
const TITLE = "cave";
const DESCRIPTION =
  "pov: you’re stuck in a cave. scroll down a passage in the rock, into a chamber the sun only reaches through a hole in its roof, to the crystals that light the rest.";

// The share image and the icons are files next to this one (opengraph-image, twitter-image, icon, apple-icon)
export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: TITLE,
  openGraph: { title: TITLE, description: DESCRIPTION, siteName: TITLE, type: "website", url: "/" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, creator: "@julien_rno" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#050806",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plain.variable} ${mono.variable}`}>
      <body>
        {children}
        {/* page views on Vercel (no cookies); does nothing when running locally */}
        <Analytics />
      </body>
    </html>
  );
}
