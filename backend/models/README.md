# Model Compatibility Reference

This directory contains the serialised model artefacts loaded by the RailSetu backend at startup.
Both files must remain in this directory and must be compatible with the architectures described below.
**Do not swap in a retrained file without verifying the compatibility requirements listed here.**

---

## `risk_model_2.json` — XGBoost Track-Risk Model

### Purpose
Predicts the 14-day track-failure probability for a single location.
Output is a float in [0, 1] mapped to risk levels: **low** (< 0.30), **medium** (0.30–0.70), **high** (> 0.70).

### Input Features

Features must be supplied in exactly this order during training and inference:

| # | Feature name      | Type  | Valid range       | Description                              |
|---|-------------------|-------|-------------------|------------------------------------------|
| 1 | `tqi`             | float | **[0, 100]**      | Track Quality Index (higher = better)    |
| 2 | `gmt`             | float | **[0, 100]**      | Geometry Mean Track index                |
| 3 | `age_since_maint` | float | **≥ 0**           | Days elapsed since last maintenance      |
| 4 | `temperature`     | float | **[−50, 80] °C**  | Ambient temperature in degrees Celsius   |

### Backend Validation
The backend enforces these ranges in `schemas.py` (`RiskPredictionRequest`) via Pydantic `Field` constraints *before* the model is called.
Any request that falls outside these bounds is rejected with **HTTP 422** — the model itself is never invoked.

### Training Notebook Compatibility Warning
Some historical notebooks used a wider GMT range (e.g. 0–150) during feature generation.
**Any notebook training a replacement model MUST clip GMT values to [0, 100] before fitting.**
A model trained on a wider range will produce out-of-distribution predictions for inputs that the backend accepts as valid, leading to silent accuracy degradation.

### Retraining Checklist
- [ ] Feature column order matches the table above exactly.
- [ ] GMT training data clipped to [0, 100].
- [ ] Model saved as a JSON Booster (`booster.save_model("risk_model_2.json")`).
- [ ] Replace the file in this directory; the backend loads it at startup via `xgb.Booster.load_model()`.

---

## `delay_model.pt` — GCN-LSTM Station Delay Model

### Purpose
Predicts the next-step delay in minutes at each of 5 railway stations along the
Secunderabad–Bibinagar corridor, given a 12-step observation window.

### Required Station Configuration

The model is hard-coded to exactly **5 stations** in the following chainage order.
Changing the number of stations or their order produces an incompatible model.

| Index | Station code | Chainage (km) |
|-------|--------------|---------------|
| 0     | SC           | 0.00          |
| 1     | MJF          | 3.40          |
| 2     | AWL          | 9.80          |
| 3     | GHKT         | 16.35         |
| 4     | BBN          | 19.90         |

### Adjacency Matrix
The graph structure is a **linear chain** with self-loops, using chainage-based node spacing
(not uniform spacing). The matrix is built by `delay_model._build_adjacency(5)` using
symmetric Kipf–Welling normalisation:

```
Â = D^{−½} (A + I) D^{−½}
```

Each station is connected only to its immediate predecessor and successor along the track.
This adjacency matrix is reconstructed at runtime from the station list — it is **not** saved
inside `delay_model.pt`.

### Network Architecture

```
Input  x_seq : [seq_len=12, N_stations=5, in_features=1]

For each time step t:
    GCNLayer(adj)
        Linear(in=1, out=16)     → [5, 16]
        adj matmul               → [5, 16]
        ReLU activation          → [5, 16]

Stacked GCN outputs            → [12, 5, 16]

LSTM(input_size=16, hidden_size=32, num_layers=1, batch_first=False)
    Final hidden state h_last   → [5, 32]

FC Linear(in=32, out=1)        → [5, 1]

Output: predicted delay (minutes) for each of the 5 stations
```

Weight tensor shapes in the saved state dict:

| Key                  | Shape     |
|----------------------|-----------|
| `gcn.linear.weight`  | (16, 1)   |
| `gcn.linear.bias`    | (16,)     |
| `lstm.weight_ih_l0`  | (128, 16) |
| `lstm.weight_hh_l0`  | (128, 32) |
| `lstm.bias_ih_l0`    | (128,)    |
| `lstm.bias_hh_l0`    | (128,)    |
| `fc.weight`          | (1, 32)   |
| `fc.bias`            | (1,)      |

### Startup Dimension Guard
At import time, `delay_model.py` loads the state dict and calls `net.eval()`.
If the file is absent or the state dict does not load into `GCNLSTMModel`, `model_available` is set to
`False` and all calls to `POST /predict/delay` return **HTTP 503**.

Any model that does not produce an output tensor of shape **(5, 1)** from a `[12, 5, 1]` input is
architecturally incompatible with this backend. **Do not bypass or remove this guard.**

### Input Format
`POST /predict/delay` accepts a `sequence` field: a 12 × 5 list of floats.
`sequence[t][s]` is the observed delay in minutes for station `s` at time step `t`.
Station index order must match the table above (SC=0, MJF=1, AWL=2, GHKT=3, BBN=4).

### Retraining Checklist
- [ ] Trained on exactly 5 stations in chainage order: SC → MJF → AWL → GHKT → BBN.
- [ ] Input feature is `delay_minutes` (one float per station per time step).
- [ ] Sequence length is exactly 12 steps.
- [ ] Architecture matches the weight shapes in the table above.
- [ ] Model saved as a PyTorch state dict (`torch.save(net.state_dict(), "delay_model.pt")`).
- [ ] Replace the file in this directory; `delay_model._load_model()` runs automatically at startup.

---

## Startup Behaviour Summary

| Model file          | Load mechanism                     | Failure mode                           |
|---------------------|------------------------------------|----------------------------------------|
| `risk_model_2.json` | `xgb.Booster.load_model()` at import | `risk_module.model_available = False` → HTTP 503  |
| `delay_model.pt`    | `torch.load()` + `load_state_dict()` at import | `delay_module.model_available = False` → HTTP 503 |

Both models are loaded eagerly when their respective modules are imported by `main.py`.
Status is logged during the FastAPI startup sequence and is visible in `uvicorn.log`.
