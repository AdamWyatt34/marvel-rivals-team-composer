"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { loadSnapshot } from "../lib/data/load";

const NAV = [
  { href: "/", label: "Composer" },
  { href: "/tier-list/", label: "Tier list" },
  { href: "/matchups/", label: "Matchups" },
  { href: "/team-ups/", label: "Team-ups" },
  { href: "/comps/", label: "Comps" },
];

/** Days without a source update before every page warns the data is stale. */
const STALE_AFTER_DAYS = 3;

export default function Nav() {
  const pathname = usePathname();
  const [staleDays, setStaleDays] = useState(0);
  useEffect(() => {
    loadSnapshot().then(
      (s) =>
        setStaleDays(
          Math.floor((Date.now() / 1000 - s.sourceTimestamp) / 86_400),
        ),
      () => {},
    );
  }, []);
  const isActive = (href: string) =>
    href === "/"
      ? pathname === "/"
      : pathname.startsWith(href.replace(/\/$/, ""));
  return (
    <>
      <nav className="site-nav" aria-label="Site">
        <span className="brand">
          <span className="brand-mark">MR</span>
          <span className="brand-label">Team Composer</span>
        </span>
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={`nav-link${isActive(item.href) ? " active" : ""}`}
          >
            {item.label}
          </Link>
        ))}
      </nav>
      {staleDays >= STALE_AFTER_DAYS && (
        <p className="stale-banner" role="status">
          Data is {staleDays} days old — the daily refresh may be failing, so
          stats may not reflect the current patch.
        </p>
      )}
    </>
  );
}
