// const API = 'https://func-rivals-comp-dev.azurewebsites.net/api';
const API = process.env.NEXT_PUBLIC_API_BASE ?? "/api";

export type ComposePayload = {
    myLocked: string[];
    enemyLocked: string[];
    myBans?: string[];
    enemyBans?: string[];
    map?: string;
    rules?: { minStrategists?: number; minVanguards?: number; teamSize?: number };
};

export type ComposeResponse = {
    primary: { role: string; hero: string }[];
    backups: Record<string, string[]>;
    suggestedBans?: string[];
    explanation: string;
};

export async function compose(payload: ComposePayload): Promise<ComposeResponse> {
    const res = await fetch(`${API}/compose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

export type Hero = { id: string; name: string; role: string; tags: string[] };

export async function getHeroes(): Promise<Hero[]> {
    const res = await fetch(`${API}/heroes`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

export type HeroDetails = {
    id: string; name: string; role: string;
    topCounters: string[]; topThreats: string[]; topSynergies: string[];
};

export async function getHeroDetails(id: string): Promise<HeroDetails> {
    const res = await fetch(`${API}/hero/${id}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

export type ThreatsResponse = Record<
    string,
    { mult: number; by?: { id: string; name: string; mult: number } }
>;

export async function getThreatsDetailed(enemyIds: string[]): Promise<ThreatsResponse> {
    const qs = enemyIds.length ? `?enemy=${encodeURIComponent(enemyIds.join(","))}` : "";
    const res = await fetch(`${API}/threats${qs}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

export async function modelCompare(ours: string[], enemy: string[], map?: string) {
    const res = await fetch(`${API}/model-compare`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ours, enemy, map }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

export type GbdtExplain = {
    prob: number;
    raw: number;
    attributions: { index: number; name: string; contrib: number; visits: number }[];
    topPositive: { index: number; name: string; contrib: number; visits: number }[];
    topNegative: { index: number; name: string; contrib: number; visits: number }[];
};

export async function modelExplainGbdt(ours: string[], enemy: string[], map?: string): Promise<GbdtExplain> {
    const res = await fetch(`${API}/model-explain-gbdt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ours, enemy, map }),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

export type MapItem = { id: string; name: string };

export async function getMaps(): Promise<MapItem[]> {
    const res = await fetch(`${API}/maps`); // or "/api/maps" if you proxy
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}