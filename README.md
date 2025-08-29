
# Marvel Rivals Team Composer

End-to-end sample that suggests optimal 6-hero team comps for **Marvel Rivals** with:
- locked picks (immutable on your side),
- symmetric bans (yours + enemy remove from both pools),
- hard role rules (**≥ 2 Strategists**, **≥ 1 Vanguard** by default),
- backups per role within 5% of optimal,
- optional short explanation via a small LLM,
- infra for Azure (Functions, Static Web Apps, Blob, App Configuration),
- CI/CD via GitHub Actions.

---

## Repo layout

```
marvel-rivals-team-composer/
├─ meta/                          # local seed data for quick dev
│  ├─ heroes.json                 # id, name, role, tags (tier:*)
│  ├─ counters.json               # per-hero vs enemy multipliers
│  ├─ synergy.json                # pair bonuses (additive)
│  └─ weights.json                # scoring weights
├─ src/
│  ├─ Composer.Core/              # scorer library
│  ├─ Composer.Functions/         # Azure Functions (dotnet-isolated)
│  └─ web/                        # Next.js app (works with SWA)
└─ infra/azure/                   # Bicep templates
```

---

## Quickstart (local)

**Prereqs**: .NET 8 SDK, Node 18+, Azure Functions Core Tools

1) **Build & run API**
```bash
dotnet build src/Composer.Functions
cd src/Composer.Functions
func start
```
API: `http://localhost:7071/api/compose`

2) **Run Web (dev)**
```bash
cd src/web
npm i
npm run dev
```
Web: `http://localhost:3000`

3) **Local data**
- `src/Composer.Functions/Program.cs` loads `/meta` by default when `USE_AZURE=false`.
- To force local meta: set env `USE_AZURE=false` before `func start`.

---

## Data model (meta/*)

### heroes.json
```json
[ { "id":"loki", "name":"Loki", "role":"Strategist", "tags":["tier:S"] } ]
```

### counters.json
Per hero → enemy multipliers. `1.15` means “strong vs”, values near `1.0` are neutral.
```json
[ { "hero":"loki", "counters": { "groot": 1.05, "peni-parker": 1.1 } } ]
```

### synergy.json
Pair bonuses (additive). Use your hero **ids** and pick one direction (no need to duplicate reverse).
```json
[ { "pair":["loki","phoenix"], "score": 1.2, "note": "Anchor enables burst" } ]
```

### weights.json
```json
{ "roleCoverage": 2.0, "synergy": 1.0, "counters": 1.2, "antiSynergy": 0.0, "mapMods": 0.0, "banRisk": 0.0 }
```

> Tip: if you put many synergy scores **>1**, consider reducing `weights.synergy` so counters and role coverage still matter.

---

## API

### POST `/api/compose`
**Body**
```json
{
  "myLocked": ["phoenix","wanda","doctor-strange"],
  "enemyLocked": ["loki","magneto"],
  "myBans": ["storm"],
  "enemyBans": ["panther"],
  "map": null,
  "rules": { "minStrategists": 2, "minVanguards": 1, "teamSize": 6 }
}
```
**Response**
```json
{
  "primary": [ {"role":"Vanguard","hero":"Photon"}, ... ],
  "backups": { "Vanguard":["Hulk","Groot"], "Strategist":["Loki"] },
  "suggestedBans": ["Magneto","Storm","Black Panther"],
  "explanation": "Short rationale..."
}
```

### GET `/api/heroes`
Returns the canonical list of heroes from the loaded roster (so you **don’t** hard-code them in the UI). See code below.

```json
[ {"id":"loki","name":"Loki","role":"Strategist","tags":["tier:S"]}, ... ]
```

## Azure deployment

### 1) Deploy infra
```bash
az group create -n rg-rivals-comp-dev -l eastus
az deployment group create -g rg-rivals-comp-dev -f infra/azure/main.bicep -p appName=rivals-comp environment=dev
```

### 2) Upload meta to Blob
```bash
STG=$(az storage account list -g rg-rivals-comp-dev --query "[0].name" -o tsv)
az storage blob upload-batch --account-name $STG -d meta/v1 -s meta
```

### 3) Set App Config
```bash
APPCE=$(az appconfig list -g rg-rivals-comp-dev --query "[0].endpoint" -o tsv)
az appconfig kv set --endpoint $APPCE --key "meta.currentVersion" --value "v1"
```

### 4) CI/CD secrets (GitHub)
- `FUNCTIONS_PUBLISH_PROFILE` (Function → Get publish profile → paste whole XML)
- `SWA_DEPLOYMENT_TOKEN` (Static Web App → Manage deployment token)
- Repo variable `FUNCTION_HOST` (e.g., `func-rivals-comp-dev.azurewebsites.net`)

Push to `main` and the provided workflows will deploy API + Web.

---

## Tuning & tips

- **Weights**: tune `weights.json` live in production by swapping `meta.currentVersion` to a new folder (`v2`) with updated numbers/files.
- **Suggested bans** appear only when `myBans` is empty. Adjust top-K in `BanRecommender`.
- **LLM explainer** (optional): set `AI__Endpoint`, `AI__ApiKey`, `AI__Model`. Otherwise it returns a friendly off message.
- **Performance**: `beamWidth` in `Composer.Compose` trades quality for speed. Start 16–32.
- **Constraints**: If you over-constrain with locks + bans, API returns `400` with a hint.

---

## Troubleshooting

- **401/403 reading Blob/App Config**: ensure role assignments for the Function’s managed identity
  - Storage Blob Data Reader on the Storage Account
  - App Configuration Data Reader on the App Config
- **Hero id mismatch**: ids must match `heroes.json` (e.g., `spider-man`, `mr-fantastic`, `cloak-and-dagger`).
- **No feasible team**: not enough Strategists/Vanguards left after bans/locks → relax inputs or change rules.
