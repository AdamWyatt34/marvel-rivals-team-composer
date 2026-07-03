import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseNuxtPage } from "./devalue-parse";

/**
 * Builds the slow-moving reference files (data/reference/*.json) from a
 * RivalsMeta character page's SSR state. Run manually when a new hero or
 * team-up ships, then review the diff:
 *
 *   npm run build-reference            # uses the checked-in fixture
 *   npm run build-reference -- --live  # fetches a fresh page
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "../../../..");
const REFERENCE_DIR = resolve(REPO_ROOT, "data/reference");
const FIXTURE = resolve(SCRIPT_DIR, "__fixtures__/matchups-thor.html");

export const USER_AGENT =
  "marvel-rivals-team-composer/1.0 (+https://github.com/AdamWyatt34/marvel-rivals-team-composer; hobby project)";

interface RivalsMetaTeamup {
  id: number;
  name: string;
  anchor?: number;
  heroes: number[];
  currentlyActive: boolean;
}

interface RivalsMetaCharacter {
  hero_id: number;
  name: string;
  role: "Tank" | "Damage" | "Support";
  Teamup?: RivalsMetaTeamup[];
  hidden: boolean;
}

const ROLE_MAP = {
  Tank: "Vanguard",
  Damage: "Duelist",
  Support: "Strategist",
} as const;

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Map names: RivalsMeta only exposes numeric map_ids; names were resolved
// once by pairing its per-map match counts against the rendered site UI
// (see git history of this file / PR notes). Mode grouping comes from the
// site's Best Maps sections. 1421 exists in the data but is not rendered on
// the site (out of rotation?) — placeholder name until identified.
const MAPS = [
  { id: "1230", name: "Shin-Shibuya", area: "Tokyo 2099", mode: "Convergence" },
  { id: "1231", name: "Yggdrasill Path", area: "Yggsgard", mode: "Convoy" },
  { id: "1245", name: "Spider-Islands", area: "Tokyo 2099", mode: "Convoy" },
  {
    id: "1267",
    name: "Hall of Djalia",
    area: "Intergalactic Empire of Wakanda",
    mode: "Convergence",
  },
  {
    id: "1272",
    name: "Birnin T'Challa",
    area: "Intergalactic Empire of Wakanda",
    mode: "Domination",
  },
  {
    id: "1288",
    name: "Hell's Heaven",
    area: "Hydra Charteris Base",
    mode: "Domination",
  },
  {
    id: "1290",
    name: "Symbiotic Surface",
    area: "Klyntar",
    mode: "Convergence",
  },
  {
    id: "1291",
    name: "Midtown",
    area: "Empire of Eternal Night",
    mode: "Convoy",
  },
  {
    id: "1292",
    name: "Central Park",
    area: "Empire of Eternal Night",
    mode: "Convergence",
  },
  { id: "1310", name: "Krakoa", area: "Hellfire Gala", mode: "Domination" },
  { id: "1311", name: "Arakko", area: "Hellfire Gala", mode: "Convoy" },
  { id: "1318", name: "Celestial Husk", area: "Klyntar", mode: "Domination" },
  {
    id: "1418",
    name: "Museum of Contemplation",
    area: "Museum of Contemplation",
    mode: "Convoy",
  },
  { id: "1421", name: "Unknown Map (1421)", area: "Unknown", mode: "Unknown" },
  {
    id: "2042",
    name: "Heart of Tiandu",
    area: "K'un-Lun",
    mode: "Convergence",
  },
];

async function loadCharacters(live: boolean): Promise<RivalsMetaCharacter[]> {
  let html: string;
  if (live) {
    const res = await fetch("https://rivalsmeta.com/characters/thor/matchups", {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`RivalsMeta returned ${res.status}`);
    html = await res.text();
  } else {
    html = readFileSync(FIXTURE, "utf8");
  }
  const payload = parseNuxtPage(html);
  const characters = payload.state?.["$scharacters"] as
    RivalsMetaCharacter[] | undefined;
  if (!Array.isArray(characters) || characters.length < 35) {
    throw new Error(
      `Expected >=35 characters in page state, got ${characters?.length ?? "none"}`,
    );
  }
  return characters;
}

async function main() {
  const live = process.argv.includes("--live");
  const characters = await loadCharacters(live);

  const heroes = characters
    .filter((c) => !c.hidden)
    .map((c) => ({
      id: slugify(c.name),
      name: c.name,
      rivalsMetaId: c.hero_id,
      role: ROLE_MAP[c.role],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const dupes = heroes.filter(
    (h, _, all) => all.filter((x) => x.id === h.id).length > 1,
  );
  if (dupes.length > 0) {
    throw new Error(
      `Duplicate hero slugs: ${dupes.map((d) => d.id).join(", ")}`,
    );
  }

  const teamupsById = new Map<number, RivalsMetaTeamup>();
  for (const c of characters) {
    for (const t of c.Teamup ?? []) teamupsById.set(t.id, t);
  }
  const heroIdToSlug = new Map(heroes.map((h) => [h.rivalsMetaId, h.id]));
  const teamups = [...teamupsById.values()]
    .map((t) => ({
      id: t.id,
      name: t.name,
      anchor: t.anchor != null ? (heroIdToSlug.get(t.anchor) ?? null) : null,
      heroes: t.heroes
        .map((id) => heroIdToSlug.get(id))
        .filter((s): s is string => s != null),
      currentlyActive: t.currentlyActive,
    }))
    .sort((a, b) => a.id - b.id);

  mkdirSync(REFERENCE_DIR, { recursive: true });
  const write = (file: string, value: unknown) =>
    writeFileSync(
      resolve(REFERENCE_DIR, file),
      JSON.stringify(value, null, 2) + "\n",
    );
  write("heroes.json", heroes);
  write("maps.json", MAPS);
  write("teamups.json", teamups);
  console.log(
    `Wrote ${heroes.length} heroes, ${MAPS.length} maps, ${teamups.length} team-ups to ${REFERENCE_DIR}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
