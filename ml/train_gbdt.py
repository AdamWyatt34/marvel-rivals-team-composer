# ml/train_gbdt.py
import datetime as dt
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
from typing import Any, Dict, List

import lightgbm as lgb
import numpy as np
import pandas as pd

# ---------- config (env) ----------
KEEP_DAYS   = int(os.getenv("TRAIN_KEEP_DAYS", "0"))     # 0 = use all CSVs
HASH_DIM    = int(os.getenv("PAIR_HASH_DIM", "512"))     # pair-hash buckets
RUN_ID      = os.getenv("RUN_ID") or dt.datetime.utcnow().strftime("%Y%m%d-%H%M%S")
OUT_DIR     = os.getenv("OUT_DIR", "out")

# priors knobs
PRIOR_ALPHA = float(os.getenv("PRIOR_ALPHA", "10.0"))    # smoothing toward base rate (8–12 good)
PRIOR_SCALE = float(os.getenv("PRIOR_SCALE", "2.0"))     # multiply prior features before training

# popularity reweighting (gentle)
ALPHA       = float(os.getenv("POP_BALANCE_ALPHA", "0.25"))  # 0.0=off; 0.1–0.3 mild

# ---------- collect CSVs ----------
paths = sys.argv[1:]
if not paths:
    print("No CSV paths provided."); sys.exit(0)

def file_date_ok(p: str) -> bool:
    if KEEP_DAYS <= 0: return True
    base = os.path.basename(p)
    m = re.search(r"(\d{8})", base)  # matches-YYYYMMDD*.csv
    if not m: return True
    try:
        d = dt.datetime.strptime(m.group(1), "%Y%m%d").date()
        return (dt.date.today() - d).days <= KEEP_DAYS
    except Exception:
        return True

paths = [p for p in paths if file_date_ok(p)]
if not paths:
    print("No CSVs after date filtering."); sys.exit(0)

# ---------- load data ----------
dfs = []
for p in paths:
    try:
        dfs.append(pd.read_csv(p))
    except Exception as ex:
        print(f"Skipping {p}: {ex}")
if not dfs:
    print("No usable CSVs."); sys.exit(0)

df = pd.concat(dfs, ignore_index=True)

# de-dup per match_id if present
if "match_id" in df.columns:
    df = df.drop_duplicates(subset=["match_id"])

# normalize lists
def split_col(s): return [] if pd.isna(s) or s == "" else str(s).split("|")
df["our_list"]   = df["our"].apply(split_col)
df["enemy_list"] = df["enemy"].apply(split_col)

# ---------- priors (smoothed per-hero deltas) ----------
p_base = float(df["result"].mean())

def logit(p):
    p = min(max(p, 1e-6), 1-1e-6)
    import math
    return math.log(p/(1-p))

base_logit = logit(p_base)

from collections import Counter
wins, games = Counter(), Counter()
for _, row in df.iterrows():
    for h in row["our_list"]:
        games[h] += 1
        if int(row["result"]) == 1:
            wins[h] += 1

# Use your env knob here (PRIOR_ALPHA)
priors = {}
for h, g in games.items():
    p_h = (wins[h] + PRIOR_ALPHA) / (g + 2*PRIOR_ALPHA)
    priors[h] = logit(p_h) - base_logit

def prior_sum(lst):
    if not isinstance(lst, list):
        return 0.0
    return float(sum(priors.get(h, 0.0) for h in lst))

# Row-level features
df["prior_our"]   = df["our_list"].apply(prior_sum)
df["prior_enemy"] = df["enemy_list"].apply(prior_sum)

# Scale BEFORE model training (PRIOR_SCALE influences model, not the stored numbers)
df["prior_our_scaled"]   = df["prior_our"]   * PRIOR_SCALE
df["prior_enemy_scaled"] = df["prior_enemy"] * PRIOR_SCALE

# ---------- hero one-hot space ----------
HEROES = sorted(set(h for arr in pd.concat([df["our_list"], df["enemy_list"]]) for h in arr))
hero_idx = {f"our:{h}": i for i, h in enumerate(HEROES)}
offset = len(hero_idx)
for i, h in enumerate(HEROES):
    hero_idx[f"enemy:{h}"] = offset + i

def onehot(row):
    x = np.zeros(len(hero_idx), dtype=np.float32)
    for h in row.our_list:   x[hero_idx[f"our:{h}"]] = 1.0
    for h in row.enemy_list: x[hero_idx[f"enemy:{h}"]] = 1.0
    return x

X1 = np.stack(df.apply(onehot, axis=1).values).astype(np.float32)

# ---------- hashed pair/cross ----------
def hash_idx(key: str, dim: int) -> int:
    h = hashlib.sha256(key.encode('utf-8')).digest()
    v = int.from_bytes(h[:4], byteorder='little', signed=False) & 0x7fffffff
    return v % dim

def pair_feats_counts(row):
    # return sparse dict: idx -> count
    counts = Counter()
    # our pairs
    for i in range(len(row.our_list)):
        for j in range(i + 1, len(row.our_list)):
            k = f"pair:our:{row.our_list[i]}+{row.our_list[j]}"
            counts[hash_idx(k, HASH_DIM)] += 1
    # enemy pairs
    for i in range(len(row.enemy_list)):
        for j in range(i + 1, len(row.enemy_list)):
            k = f"pair:enemy:{row.enemy_list[i]}+{row.enemy_list[j]}"
            counts[hash_idx(k, HASH_DIM)] += 1
    # cross
    for a in row.our_list:
        for b in row.enemy_list:
            k = f"cross:{a}+{b}"
            counts[hash_idx(k, HASH_DIM)] += 1
    return counts

def counts_to_vector(counts: Dict[int, int]) -> np.ndarray:
    x = np.zeros(HASH_DIM, dtype=np.float32)
    for i, c in counts.items():
        x[i] = float(c)
    return x

X2 = np.stack(df.apply(lambda r: counts_to_vector(pair_feats_counts(r)), axis=1).values).astype(np.float32)

# ---------- optional map one-hot ----------
if "map" in df.columns:
    MAPS = sorted(df["map"].dropna().unique())
    m_idx = {m: i for i, m in enumerate(MAPS)}
    def mhot(m):
        x = np.zeros(len(m_idx), dtype=np.float32)
        if pd.notna(m): x[m_idx[m]] = 1.0
        return x
    X3 = np.stack(df["map"].apply(mhot).values).astype(np.float32)
else:
    MAPS = []; m_idx = {}; X3 = np.zeros((len(df), 0), dtype=np.float32)

# final matrix: [one-hots][pairs][map][priors-tail]
X = np.hstack([
    X1, X2, X3,
    df[["prior_our_scaled", "prior_enemy_scaled"]].to_numpy(dtype=np.float32)
]).astype(np.float32)
y = df["result"].astype(int).values

# ---------- (optional) gentle popularity reweighting ----------
if ALPHA > 0.0:
    freq = Counter(h for lst in df["our_list"] for h in lst)
    mean_f = np.mean([f for f in freq.values()]) if freq else 1.0
    def row_weight(row):
        ours = row["our_list"]
        if not ours:
            return 1.0
        mods = []
        for h in ours:
            f = freq.get(h, 1)
            m = (mean_f / max(1, f)) ** ALPHA
            mods.append(m)
        hm = len(mods) / sum(1.0 / m for m in mods)  # harmonic mean
        return float(np.clip(hm, 0.85, 1.15))
    w = df.apply(row_weight, axis=1).to_numpy(dtype=np.float32)
else:
    w = None

# ---------- train GBDT ----------

params = {
    "objective": "binary",
    "metric": "binary_logloss",
    "num_leaves": 63,
    "learning_rate": 0.05,
    "feature_fraction": 0.9,
    "bagging_fraction": 0.9,
    "bagging_freq": 1,
    "min_data_in_leaf": 20,
}
train = lgb.Dataset(X, label=y, weight=w, free_raw_data=False)
booster = lgb.train(params, train, num_boost_round=800)


# ---------- export (compact, scorer-friendly) ----------
def export_simple_gbdt(booster, heroes: List[str], pair_dim: int, maps: List[str]) -> Dict[str, Any]:
    model = booster.dump_model()
    average_output = float(model.get("average_output", 0.0))

    # enemy feature importance aggregate
    H = len(heroes)
    fi_gain = booster.feature_importance(importance_type="gain")
    importance_enemy: Dict[str, float] = {}
    for i, gain in enumerate(fi_gain):
        if H <= i < 2 * H:  # enemy block
            hero = heroes[i - H]
            importance_enemy[hero] = float(importance_enemy.get(hero, 0.0) + gain)

    def walk(node: Dict[str, Any], acc: List[Dict[str, Any]]) -> int:
        if "leaf_value" in node:
            acc.append({"f": -1, "th": 0.0, "l": -1, "r": -1, "leaf": float(node["leaf_value"])})
            return len(acc) - 1
        me = {"f": int(node["split_feature"]),
              "th": float(node["threshold"]),
              "l": -1, "r": -1,
              "leaf": None}
        acc.append(me)
        my_idx = len(acc) - 1
        li = walk(node["left_child"], acc)
        ri = walk(node["right_child"], acc)
        me["l"], me["r"] = li, ri
        return my_idx

    trees = []
    for ti in model["tree_info"]:
        buf: List[Dict[str, Any]] = []
        root_idx = walk(ti["tree_structure"], buf)
        trees.append({"root": root_idx, "nodes": buf})

    return {
        "schema": {
            "heroes": heroes,
            "pair_hash_dim": int(pair_dim),
            "maps": maps,
            "features_tail": ["prior_our_scaled", "prior_enemy_scaled"],
            "priors": {h: float(priors.get(h, 0.0)) for h in heroes},
            "importance_enemy": importance_enemy,
            "prior_scale": PRIOR_SCALE,
            "prior_alpha": PRIOR_ALPHA,
        },
        "bias": average_output,
        "trees": trees
    }

# ---------- write outputs ----------
run_dir    = os.path.join(OUT_DIR, RUN_ID)
latest_dir = os.path.join(OUT_DIR, "latest")
os.makedirs(run_dir, exist_ok=True)
os.makedirs(latest_dir, exist_ok=True)

simple = export_simple_gbdt(booster, HEROES, HASH_DIM, MAPS)

json_path = os.path.join(run_dir, "gbdt_model.json")
gz_path   = os.path.join(run_dir, "gbdt_model.json.gz")

with open(json_path, "w", encoding="utf-8") as f:
    json.dump(simple, f)

with gzip.open(gz_path, "wt", encoding="utf-8") as f:
    json.dump(simple, f)

manifest = {
    "run_id": RUN_ID,
    "created_utc": dt.datetime.utcnow().isoformat(timespec="seconds") + "Z",
    "hash_sha256": hashlib.sha256(open(json_path, "rb").read()).hexdigest(),
    "used_files": paths,
    "n_rows": int(len(df)),
    "n_features": int(X.shape[1]),
    "pair_hash_dim": HASH_DIM,
    "heroes_count": int(len(HEROES)),
    "maps": list(map(str, MAPS)),
    "pop_balance_alpha": ALPHA,
    "prior_alpha": PRIOR_ALPHA,
    "prior_scale": PRIOR_SCALE,
}
with open(os.path.join(run_dir, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump(manifest, f, indent=2)

shutil.copy2(gz_path, os.path.join(latest_dir, "gbdt_model.json.gz"))
with open(os.path.join(latest_dir, "manifest.json"), "w", encoding="utf-8") as f:
    json.dump({"current": RUN_ID}, f)

print(f"✅ Wrote {json_path} and {gz_path}")
print(f"✅ Updated {os.path.join(latest_dir, 'gbdt_model.json.gz')}")
