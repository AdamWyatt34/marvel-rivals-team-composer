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

  // Group by anchor hero: each hero owns two team-ups but selects only one
  // per game, so the choice is what the page should surface.
  const byAnchor = new Map<string, TeamUpRow[]>();
  for (const row of rows) {
    const key = row.anchor ?? row.name;
    const group = byAnchor.get(key);
    if (group == null) byAnchor.set(key, [row]);
    else group.push(row);
  }

  return (
    <MetaPage
      title="Team-ups"
      subtitle="Each hero has two team-ups but selects one per game; the effect is enhanced when the partner is on the team. Win rates are per member combination — high win rates on rarely-played variants mean little, check the sample."
    >
      <div style={{ marginBottom: 12 }}>
        <BandSelect band={band} onChange={setBand} />
      </div>
      {error && <p style={{ color: "var(--enemy)" }}>{error}</p>}
      {[...byAnchor.entries()].map(([anchor, teamUps]) => (
        <section key={anchor} style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 15, margin: "0 0 2px" }}>{anchor}</h2>
          <p style={{ margin: "0 0 6px", color: "var(--muted)", fontSize: 12 }}>
            {teamUps.length > 1
              ? `selects one of ${teamUps.length} team-ups per game`
              : "team-up"}
          </p>
          <div style={{ overflowX: "auto" }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Team-up</th>
                  <th style={thStyle}>Combination</th>
                  <th style={thStyle}>Win rate</th>
                  <th style={thStyle}>Matches</th>
                </tr>
              </thead>
              <tbody>
                {teamUps.flatMap((teamUp) =>
                  teamUp.variants.map((v) => (
                    <tr key={`${teamUp.id}:${v.members.join("+")}`}>
                      <td style={{ ...tdStyle, fontWeight: 600 }}>
                        {teamUp.name}
                      </td>
                      <td style={tdStyle}>{v.members.join(" + ")}</td>
                      <td
                        style={{
                          ...tdStyle,
                          fontVariantNumeric: "tabular-nums",
                        }}
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
                  )),
                )}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </MetaPage>
  );
}
