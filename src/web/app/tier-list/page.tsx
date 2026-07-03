"use client";

import { useEffect, useState } from "react";
import { getTierList, type TierListRow } from "../local-api";
import {
  BandSelect,
  MetaPage,
  Meter,
  roleBadge,
  tableStyle,
  tdStyle,
  thStyle,
  tierBadge,
} from "../meta-ui";
import type { TierBand } from "../../lib/engine";

export default function TierListPage() {
  const [band, setBand] = useState<TierBand>("platinum+");
  const [rows, setRows] = useState<TierListRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTierList(band)
      .then(setRows)
      .catch((e) => setError(String(e)));
  }, [band]);

  const maxPick = Math.max(0.001, ...rows.map((r) => r.pickShare));

  return (
    <MetaPage
      title="Tier list"
      subtitle="Ranked by de-biased strength: win rates shrunk for sample size, corrected for one-trick specialist inflation, and capped — not raw win %. 'Adjusted' is the estimated win-rate impact of the hero vs an average pick."
    >
      <div style={{ marginBottom: 12 }}>
        <BandSelect band={band} onChange={setBand} />
      </div>
      {error && <p style={{ color: "var(--enemy)" }}>{error}</p>}
      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>#</th>
              <th style={thStyle}>Hero</th>
              <th style={thStyle}>Role</th>
              <th style={thStyle}>Tier</th>
              <th style={thStyle}>Adjusted</th>
              <th style={thStyle}>Raw WR</th>
              <th style={thStyle}>Pick share</th>
              <th style={thStyle}>Ban rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id}>
                <td style={{ ...tdStyle, color: "var(--muted)" }}>{i + 1}</td>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{r.name}</td>
                <td style={tdStyle}>
                  <span style={roleBadge(r.role)}>{r.role}</span>
                </td>
                <td style={tdStyle}>
                  <span style={tierBadge(r.tier)}>{r.tier}</span>
                </td>
                <td
                  style={{
                    ...tdStyle,
                    fontVariantNumeric: "tabular-nums",
                    color:
                      r.adjustedDelta > 0.002
                        ? "var(--tier-a)"
                        : r.adjustedDelta < -0.002
                          ? "var(--enemy)"
                          : "var(--muted)",
                  }}
                >
                  {r.adjustedDelta >= 0 ? "+" : ""}
                  {(r.adjustedDelta * 100).toFixed(1)}%
                </td>
                <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                  {r.rawWinRate != null
                    ? `${(r.rawWinRate * 100).toFixed(1)}%`
                    : "—"}
                </td>
                <td style={tdStyle}>
                  <Meter
                    value={r.pickShare}
                    max={maxPick}
                    format={`${(r.pickShare * 100).toFixed(1)}%`}
                  />
                </td>
                <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                  {(r.banRate * 100).toFixed(1)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </MetaPage>
  );
}
