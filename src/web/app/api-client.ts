const API = 'https://func-rivals-comp-dev.azurewebsites.net/api';

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