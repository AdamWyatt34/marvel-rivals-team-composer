import json, sys, numpy as np, pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.feature_extraction import FeatureHasher

inputs = sys.argv[1:]
if not inputs:
    print("No CSVs found")
    open("lr_model.json", "w").write(json.dumps({
        "bias":0.0,"hero_features":{},"pair_hash_dim":512,"pair_weights":[0.0]*512,"map_weights":[],"maps":[]
    })); sys.exit(0)

df = pd.concat([pd.read_csv(p) for p in inputs], ignore_index=True)

# (1) Dedupe by match_id
if "match_id" in df.columns:
    df = df.drop_duplicates(subset=["match_id"])

def split_col(s): return [] if pd.isna(s) or s=="" else str(s).split("|")
df["our_list"]   = df["our"].apply(split_col)
df["enemy_list"] = df["enemy"].apply(split_col)

heroes = sorted(set(h for arr in pd.concat([df["our_list"], df["enemy_list"]]) for h in arr))
col_idx = { f"our:{h}": i for i,h in enumerate(heroes) }
offset  = len(col_idx)
for i,h in enumerate(heroes):
    col_idx[f"enemy:{h}"] = offset + i

def onehot(row):
    x = np.zeros(len(col_idx), dtype=np.float32)
    for h in row.our_list:   x[col_idx[f"our:{h}"]] = 1.0
    for h in row.enemy_list: x[col_idx[f"enemy:{h}"]] = 1.0
    return x

X1 = np.stack(df.apply(onehot, axis=1).values)

def pair_feats(row):
    feats=[]
    # same-team pairs
    for i in range(len(row.our_list)):
        for j in range(i+1, len(row.our_list)):
            feats.append(f"pair:our:{row.our_list[i]}+{row.our_list[j]}")
    for i in range(len(row.enemy_list)):
        for j in range(i+1, len(row.enemy_list)):
            feats.append(f"pair:enemy:{row.enemy_list[i]}+{row.enemy_list[j]}")
    # cross-team pairs
    for h1 in row.our_list:
        for h2 in row.enemy_list:
            feats.append(f"cross:{h1}+{h2}")
    return feats

HASH_DIM = 512
hasher = FeatureHasher(n_features=HASH_DIM, input_type="string")
X2 = hasher.transform(df.apply(pair_feats, axis=1)).toarray()

# optional map one-hot
if "map" in df.columns:
    maps = sorted(df["map"].dropna().unique())
    m_idx = { m:i for i,m in enumerate(maps) }
    def mhot(m):
        x = np.zeros(len(m_idx), dtype=np.float32)
        if pd.notna(m): x[m_idx[m]] = 1.0
        return x
    X3 = np.stack(df["map"].apply(mhot).values)
else:
    maps=[]; X3 = np.zeros((len(df),0))

X = np.hstack([X1, X2, X3])
y = df["result"].astype(int).values

# (4) Time-decay sample weights (recent matches count more).
# Expect ISO 8601 in df["timestamp"]; if missing/invalid, those rows get neutral weight.
df["ts"] = pd.to_datetime(df["timestamp"], errors="coerce", utc=True)
max_ts = df["ts"].max()
# Half-life = 30 days (tweak freely). weight = 0.5 ** (age_days / 30)
age_days = (max_ts - df["ts"]).dt.total_seconds().fillna(0) / 86400.0
w = (0.5 ** (age_days / 30.0)).values
# normalize so average weight ~ 1 (optional but helps stability)
w = w / (w.mean() if w.mean() > 0 else 1)

clf = LogisticRegression(max_iter=300, solver="lbfgs")
clf.fit(X, y, sample_weight=w)  # ⬅ pass weights here

wvec = clf.coef_[0]
weights = {
    "bias": float(clf.intercept_[0]),
    "hero_features": {name: float(wvec[idx]) for name, idx in col_idx.items()},
    "pair_hash_dim": HASH_DIM,
    "pair_weights": wvec[len(col_idx):len(col_idx)+HASH_DIM].tolist(),
    "map_weights": wvec[len(col_idx)+HASH_DIM:].tolist(),
    "maps": maps
}
with open("lr_model.json","w",encoding="utf-8") as f:
    json.dump(weights,f)
print("Wrote lr_model.json")
