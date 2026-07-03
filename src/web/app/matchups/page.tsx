"use client";

import { useEffect, useState } from "react";
import {
  getHeroes,
  getMatchupTable,
  type Hero,
  type MatchupRow,
} from "../local-api";
import {
  DivergingMeter,
  MetaPage,
  roleBadge,
  tableStyle,
  tdStyle,
  thStyle,
} from "../meta-ui";

export default function MatchupsPage() {
  const [heroes, setHeroes] = useState<Hero[]>([]);
  const [selected, setSelected] = useState<string>("thor");
  const [rows, setRows] = useState<MatchupRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getHeroes("all")
      .then((all) =>
        setHeroes([...all].sort((a, b) => a.name.localeCompare(b.name))),
      )
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    getMatchupTable(selected)
      .then(setRows)
      .catch((e) => setError(String(e)));
  }, [selected]);

  const maxEdge = Math.max(0.05, ...rows.map((r) => Math.abs(r.edge)));
  const selectedName = heroes.find((h) => h.id === selected)?.name ?? selected;

  return (
    <MetaPage
      title="Matchups"
      subtitle="Hero-vs-hero win rates when the opponent is on the enemy team (Diamond+ sample), shrunk toward the hero's own baseline so sparse matchups don't overclaim."
    >
      <div style={{ marginBottom: 12 }}>
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="Select hero"
          style={{
            padding: "8px 10px",
            borderRadius: 10,
            border: "1px solid var(--border)",
            background: "var(--card)",
            color: "var(--text)",
            fontSize: 13,
          }}
        >
          {heroes.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </div>
      {error && <p style={{ color: "var(--enemy)" }}>{error}</p>}
      <div style={{ overflowX: "auto" }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Opponent</th>
              <th style={thStyle}>Role</th>
              <th style={thStyle}>{selectedName}&apos;s edge</th>
              <th style={thStyle}>Raw WR vs</th>
              <th style={thStyle}>Sample</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td style={{ ...tdStyle, fontWeight: 600 }}>{r.name}</td>
                <td style={tdStyle}>
                  <span style={roleBadge(r.role)}>{r.role}</span>
                </td>
                <td style={tdStyle}>
                  <DivergingMeter
                    value={r.edge}
                    max={maxEdge}
                    format={`${r.edge >= 0 ? "+" : ""}${(r.edge * 25).toFixed(1)}pp`}
                  />
                </td>
                <td style={{ ...tdStyle, fontVariantNumeric: "tabular-nums" }}>
                  {(r.winRate * 100).toFixed(1)}%
                </td>
                <td
                  style={{
                    ...tdStyle,
                    color: "var(--muted)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {r.matches.toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </MetaPage>
  );
}
