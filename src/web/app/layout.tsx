import type { Metadata } from "next";
import Nav from "./Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Marvel Rivals Team Composer",
  description: "Pick optimal comps, bans & backups.",
  icons: { icon: "/favicon.ico" },
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
      </body>
    </html>
  );
}
