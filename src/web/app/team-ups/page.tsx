"use client";

import { useEffect, useState } from "react";
import { getTeamUpStats, type TeamUpRow } from "../local-api";
import {
  BandSelect,
  MetaPage,
  Meter,
  tableStyle,
  tdStyle,
  thStyle,
} from "../meta-ui";
import type { TierBand } from "../../lib/engine";

export default function TeamUpsPage() {
  const [band, setBand] = useState<TierBand>("platinum+");
  const [rows, setRows] = useState<TeamUpRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTeamUpStats(band)
      .then(setRows)
      .catch((e) => setError(String(e)));
  }, [band]);

  const maxMatches = Math.max(
    1,
    ...rows.flatMap((r) => r.variants.map((v) => v.matches)),
  );

  return (
    <MetaPage
      title="Team-ups"
      subtitle="Active team-ups with observed win rates per member combination. High win rates on rarely-played variants mean little — check the sample."
    >
      <div style={{ marginBottom: 12 }}>
        <BandSelect band={band} onChange={setBand} />
      </div>
      {error && <p style={{ color: "var(--enemy)" }}>{error}</p>}
      {rows.map((teamUp) => (
        <section key={teamUp.id} style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 15, margin: "0 0 2px" }}>{teamUp.name}</h2>
          <p style={{ margin: "0 0 6px", color: "var(--muted)", fontSize: 12 }}>
            {teamUp.members.join(" · ")}
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Combination</th>
                  <th style={thStyle}>Win rate</th>
                  <th style={thStyle}>Matches</th>
                </tr>
              </thead>
              <tbody>
                {teamUp.variants.map((v) => (
                  <tr key={v.members.join("+")}>
                    <td style={{ ...tdStyle, fontWeight: 600 }}>
                      {v.members.join(" + ")}
                    </td>
                    <td
                      style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}
                    >
                      {(v.winRate * 100).toFixed(1)}%
                    </td>
                    <td style={tdStyle}>
                      <Meter
                        value={v.matches}
                        max={maxMatches}
                        format={v.matches.toLocaleString()}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </MetaPage>
  );
}
