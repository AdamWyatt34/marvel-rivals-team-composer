"use client";

import { useEffect, useState } from "react";
import { getRoleShapes, type RoleShapeRow } from "../local-api";
import {
  BandSelect,
  MetaPage,
  Meter,
  tableStyle,
  tdStyle,
  thStyle,
} from "../meta-ui";
import type { TierBand } from "../../lib/engine";

export default function CompsPage() {
  const [band, setBand] = useState<TierBand>("platinum+");
  const [rows, setRows] = useState<RoleShapeRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getRoleShapes(band)
      .then(setRows)
      .catch((e) => setError(String(e)));
  }, [band]);

  const maxMatches = Math.max(1, ...rows.map((r) => r.matches));

  return (
    <MetaPage
      title="Role compositions"
      subtitle="How team shapes (Vanguards-Duelists-Strategists) perform at each rank band. The composer softly prefers shapes that win here, beyond its hard 1-1-2 minimums."
    >
      <div style={{ marginBottom: 12 }}>
        <BandSelect band={band} onChange={setBand} />
      </div>
      {error && <p style={{ color: "var(--enemy)" }}>{error}</p>}
      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Shape (V-D-S)</th>
              <th style={thStyle}>Composition</th>
              <th style={thStyle}>Win rate</th>
              <th style={thStyle}>Matches</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.shape}>
                <td
                  style={{
                    ...tdStyle,
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {r.shape}
                </td>
                <td style={tdStyle}>{r.label}</td>
                <td
                  style={{
                    ...tdStyle,
                    fontVariantNumeric: "tabular-nums",
                    color:
                      r.winRate > 0.51
                        ? "var(--tier-a)"
                        : r.winRate < 0.49
                          ? "var(--enemy)"
                          : "var(--text)",
                  }}
                >
                  {(r.winRate * 100).toFixed(1)}%
                </td>
                <td style={tdStyle}>
                  <Meter
                    value={r.matches}
                    max={maxMatches}
                    format={r.matches.toLocaleString()}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </MetaPage>
  );
}
