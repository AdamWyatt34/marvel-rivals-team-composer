"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/", label: "Composer" },
  { href: "/tier-list/", label: "Tier list" },
  { href: "/matchups/", label: "Matchups" },
  { href: "/team-ups/", label: "Team-ups" },
  { href: "/comps/", label: "Comps" },
];

export default function Nav() {
  const pathname = usePathname();
  const isActive = (href: string) =>
    href === "/"
      ? pathname === "/"
      : pathname.startsWith(href.replace(/\/$/, ""));
  return (
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
  );
}
