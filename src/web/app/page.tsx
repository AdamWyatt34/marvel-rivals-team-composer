"use client";
import { useEffect, useMemo, useState } from "react";
import {compose, ComposeResponse, getHeroes, Hero, getThreatsDetailed} from "./api-client";
import HeroPicker from "./HeroPicker";

type HL = "my" | "enemy" | "myban" | "enemyban";

export default function Home() {
    const [allHeroes, setAllHeroes] = useState<Hero[]>([]);
    const [my, setMy] = useState<string[]>([]);
    const [enemy, setEnemy] = useState<string[]>([]);
    const [myBans, setMyBans] = useState<string[]>([]);
    const [enemyBans, setEnemyBans] = useState<string[]>([]);
    const [resp, setResp] = useState<ComposeResponse | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [warn, setWarn] = useState<Record<string, number>>({});
    const [warnWhy, setWarnWhy] = useState<Record<string, string>>({});

    useEffect(() => { getHeroes().then(setAllHeroes).catch(e => setErr(String(e))); }, []);

    useEffect(() => {
        getThreatsDetailed(enemy)
            .then(map => {
                const w: Record<string, number> = {};
                const why: Record<string, string> = {};
                for (const [heroId, entry] of Object.entries(map)) {
                    w[heroId] = entry.mult ?? 1.0;
                    if (entry.by && entry.by.mult > 1.0) {
                        why[heroId] = `Countered by ${entry.by.name} (x${entry.by.mult.toFixed(2)})`;
                    }
                }
                setWarn(w);
                setWarnWhy(why);
            })
            .catch(() => { setWarn({}); setWarnWhy({}); });
    }, [enemy]);

    // Build one highlight map so all pickers show global status
    const highlight = useMemo(() => {
        const m: Record<string, HL> = {};
        for (const id of enemyBans) m[id] = "enemyban";
        for (const id of myBans)    m[id] = "myban";
        for (const id of enemy)     m[id] = "enemy";
        for (const id of my)        m[id] = "my";
        return m;
    }, [my, enemy, myBans, enemyBans]);

    async function onCompose() {
        setErr(null); setResp(null); setBusy(true);
        try {
            const r = await compose({
                myLocked: my,
                enemyLocked: enemy,
                myBans,
                enemyBans,
                rules: { minStrategists: 2, minVanguards: 1, teamSize: 6 }
            });
            setResp(r);
            // eslint-disable-next-line @typescript-eslint/ban-ts-comment
            // @ts-expect-error
        } catch (e: never) {
            setErr(typeof e?.message === "string" ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <main style={{ padding:24, maxWidth:980, margin:"0 auto", background:"var(--bg)", color:"var(--text)", minHeight:"100vh" }}>
        <h1 style={{marginBottom:6}}>Marvel Rivals Team Composer</h1>
            <p style={{marginTop:0, color:"#555"}}>Pick up to 6 locked teammates, up to 6 enemy picks, and optional bans for both sides. Bans are symmetric.</p>

            {/* Summary Bar */}
            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, margin:"10px 0 18px"}}>
                <Summary title={`My locked (${my.length}/6)`} ids={my} allHeroes={allHeroes} pillColor="#2563eb" onRemove={id => setMy(my.filter(x => x!==id))}/>
                <Summary title={`Enemy locked (${enemy.length}/6)`} ids={enemy} allHeroes={allHeroes} pillColor="#dc2626" onRemove={id => setEnemy(enemy.filter(x => x!==id))}/>
                <Summary title={`My bans (${myBans.length})`} ids={myBans} allHeroes={allHeroes} pillColor="#6b7280" onRemove={id => setMyBans(myBans.filter(x => x!==id))}/>
                <Summary title={`Enemy bans (${enemyBans.length})`} ids={enemyBans} allHeroes={allHeroes} pillColor="#6b7280" onRemove={id => setEnemyBans(enemyBans.filter(x => x!==id))}/>
            </div>

            <HeroPicker label="My locked"     allHeroes={allHeroes} selected={my}        setSelected={setMy}        limit={6} highlight={highlight} warn={warn} warnWhy={warnWhy}/>
            <HeroPicker label="Enemy locked"  allHeroes={allHeroes} selected={enemy}     setSelected={setEnemy}     limit={6} highlight={highlight} warn={warn} warnWhy={warnWhy}/>
            <HeroPicker label="My bans"       allHeroes={allHeroes} selected={myBans}    setSelected={setMyBans}            highlight={highlight} warn={warn} warnWhy={warnWhy}/>
            <HeroPicker label="Enemy bans"    allHeroes={allHeroes} selected={enemyBans} setSelected={setEnemyBans}         highlight={highlight} warn={warn} warnWhy={warnWhy}/>

            <BottomBar busy={busy} onCompose={onCompose} onClear={() => { setResp(null); setErr(null); }} />


            {err && <pre style={{marginTop:16, color:"#b00020", whiteSpace:"pre-wrap"}}>{err}</pre>}

            {resp && (
                <section style={{marginTop:24}}>
                    <h2>Primary Lineup</h2>
                    <ul>
                        {resp.primary.map((x, idx) => <li key={idx}><strong>{x.role}</strong>: {x.hero}</li>)}
                    </ul>
                    <h3>Backups per Role</h3>
                    {Object.entries(resp.backups).map(([role, names]) => (
                        <div key={role}><strong>{role}:</strong> {names.length ? names.join(", ") : "—"}</div>
                    ))}
                    {resp.suggestedBans && resp.suggestedBans.length > 0 && (
                        <p><strong>Suggested bans:</strong> {resp.suggestedBans.join(", ")}</p>
                    )}
                    <p style={{marginTop:12}}>{resp.explanation}</p>
                </section>
            )}
        </main>
    );
}

/** Small pill list used in the Summary Bar */
function Summary({
                     title, ids, allHeroes, pillColor = "#111",
                     onRemove
                 }: {
    title: string;
    ids: string[];
    allHeroes: Hero[];
    pillColor?: string;
    onRemove: (id: string) => void;
}) {
    return (
        <div>
            <div style={{fontWeight:600, marginBottom:6}}>{title}</div>
            <div style={{display:"flex", flexWrap:"wrap", gap:6, minHeight:28}}>
                {ids.length === 0 ? <span style={{color:"#666"}}>—</span> :
                    ids.map(id => {
                        const h = allHeroes.find(x => x.id === id);
                        const name = h?.name ?? id;
                        return (
                            <span
                                key={id}
                                style={{
                                    display:"inline-flex", alignItems:"center", gap:6,
                                    background:"var(--card)", color:"var(--text)",
                                    border:`1px solid ${pillColor ?? "var(--border)"}`,
                                    borderRadius:999, padding:"4px 8px"
                                }}
                            >
                                  <span
                                      style={{
                                          width:8, height:8, borderRadius:999, background:pillColor,
                                          boxShadow:`0 0 0 2px var(--card)` /* ring for contrast on dark */
                                      }}
                                  />
                                {name}
                                <button
                                    onClick={() => onRemove(id)}
                                    aria-label={`Remove ${name}`}
                                    style={{ border:"none", background:"transparent", cursor:"pointer", fontSize:14, lineHeight:1, padding:0, margin:0 }}
                                >
                                ×
                              </button>
                            </span>

                        );
                    })
                }
            </div>
        </div>
    );
}

function BottomBar({
                       busy, onCompose, onClear
                   }: { busy: boolean; onCompose: () => void; onClear: () => void; }) {
    return (
        <div style={{
            position: "sticky",
            bottom: 0,
            zIndex: 20,
            background: "color-mix(in oklab, var(--bg) 80%, transparent)",
            backdropFilter: "saturate(1.2) blur(6px)",
            borderTop: "1px solid var(--border)",
            padding: "10px max(env(safe-area-inset-right),16px) calc(10px + env(safe-area-inset-bottom)) max(env(safe-area-inset-left),16px)",
            marginTop: 12,
        }}>
            <div style={{display:"flex", gap:10, justifyContent:"flex-end"}}>
                <button
                    onClick={onClear}
                    style={{
                        padding:"10px 16px", borderRadius:10, border:"1px solid var(--border)",
                        background:"var(--chip)", color:"var(--text)"
                    }}
                >
                    Clear Output
                </button>

                <button
                    onClick={onCompose}
                    disabled={busy}
                    style={{
                        padding:"10px 16px", borderRadius:10,
                        border:"1px solid transparent",
                        background: busy ? "var(--chip)" : "var(--my)",
                        color: busy ? "var(--text)" : "#fff",
                        opacity: busy ? 0.8 : 1
                    }}
                >
                    {busy ? "Composing…" : "Compose Team"}
                </button>

            </div>
        </div>
    );
}

