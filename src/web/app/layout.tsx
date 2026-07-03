import type { Metadata, Viewport } from "next";
import Nav from "./Nav";
import PwaSetup from "./PwaSetup";
import "./globals.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
  title: "Marvel Rivals Team Composer",
  description: "Pick optimal comps, bans & backups.",
  manifest: `${basePath}/manifest.webmanifest`,
  icons: {
    icon: `${basePath}/icon-192.png`,
    apple: `${basePath}/apple-touch-icon.png`,
  },
};

export const viewport: Viewport = {
  themeColor: "#0f172a",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="app-body">
        <Nav />
        {children}
        <PwaSetup />
      </body>
    </html>
  );
}
