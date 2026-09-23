"""
delay_model.py — Stage 3b: GCN-LSTM Delay Prediction.

Reconstructs the EXACT GCN-LSTM architecture used during training in the
Colab notebook and loads the saved state dict from delay_model.pt.

Architecture (reverse-engineered from weight tensor shapes):
    gcn.linear.weight : (16, 1)     → Linear(in=1, out=16)
    gcn.linear.bias   : (16,)
    lstm.weight_ih_l0 : (128, 16)   → LSTM(input_size=16, hidden_size=32)
    lstm.weight_hh_l0 : (128, 32)     4×hidden = 128 → hidden_size=32
    lstm.bias_ih_l0   : (128,)
    lstm.bias_hh_l0   : (128,)
    fc.weight         : (1, 32)     → Linear(in=32, out=1)
    fc.bias           : (1,)

Network flow per time step:
    x [N_stations, 1]
      → GCN(adj) → h_gcn [N_stations, 16]
      → LSTM (sequence of 12 steps) → h_lstm [N_stations, 32]
      → FC → out [N_stations, 1]

Stations (5, in chainage order, matching training data):
    SC (0.00 km), MJF (3.40 km), AWL (9.80 km), GHKT (16.35 km), BBN (19.90 km)

Input to POST /predict/delay:
    A list of 12 time-step observations, each with one delay feature per
    station (the raw delay reading fed during training).

Returns:
    Predicted delay in minutes for each of the 5 stations.
"""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

log = logging.getLogger("railsetu.delay_model")

# ---------------------------------------------------------------------------
# Model file location
# ---------------------------------------------------------------------------

_MODEL_DIR = Path(__file__).parent / "models"
_MODEL_PATH = _MODEL_DIR / "delay_model.pt"

# ---------------------------------------------------------------------------
# Station registry (order must match training data column order)
# ---------------------------------------------------------------------------

STATIONS: list[str] = ["SC", "MJF", "AWL", "GHKT", "BBN"]
N_STATIONS: int = len(STATIONS)  # 5

# Sequence length (number of time steps the LSTM was trained on)
SEQ_LEN: int = 12

# ---------------------------------------------------------------------------
# GCN-LSTM architecture — EXACT match to training notebook
# ---------------------------------------------------------------------------


class GCNLayer(nn.Module):
    """
    Simple spectral-style GCN layer:
        H' = σ(Â · X · W)
    where Â is the normalised adjacency (with self-loops).
    """

    def __init__(self, in_features: int, out_features: int) -> None:
        super().__init__()
        self.linear = nn.Linear(in_features, out_features)

    def forward(self, x: torch.Tensor, adj: torch.Tensor) -> torch.Tensor:
        # adj: [N, N], x: [N, in_features]
        support = self.linear(x)          # [N, out_features]
        out     = torch.matmul(adj, support)  # [N, out_features]
        return torch.relu(out)


class GCNLSTMModel(nn.Module):
    """
    GCN-LSTM model for station-level delay prediction.

    Input  : x_seq  [seq_len, N_stations, in_features]
              adj    [N_stations, N_stations]  (pre-computed, normalised)
    Output : out    [N_stations, 1]
    """

    def __init__(
        self,
        n_stations: int = N_STATIONS,
        in_features: int = 1,
        gcn_out: int = 16,
        lstm_hidden: int = 32,
        num_layers: int = 1,
    ) -> None:
        super().__init__()
        self.gcn  = GCNLayer(in_features, gcn_out)
        self.lstm = nn.LSTM(gcn_out, lstm_hidden, num_layers=num_layers, batch_first=False)
        self.fc   = nn.Linear(lstm_hidden, 1)

    def forward(self, x_seq: torch.Tensor, adj: torch.Tensor) -> torch.Tensor:
        """
        x_seq : [seq_len, N_stations, in_features]
        adj   : [N_stations, N_stations]
        """
        seq_len = x_seq.shape[0]

        # Apply GCN to each time step → [seq_len, N_stations, gcn_out]
        gcn_out_seq = []
        for t in range(seq_len):
            h_gcn = self.gcn(x_seq[t], adj)  # [N_stations, gcn_out]
            gcn_out_seq.append(h_gcn)
        gcn_out_tensor = torch.stack(gcn_out_seq, dim=0)  # [seq_len, N_stations, gcn_out]

        # LSTM over time: input [seq_len, N_stations, gcn_out]
        lstm_out, _ = self.lstm(gcn_out_tensor)  # [seq_len, N_stations, lstm_hidden]
        h_last       = lstm_out[-1]              # [N_stations, lstm_hidden]

        # Final linear projection
        out = self.fc(h_last)  # [N_stations, 1]
        return out


# ---------------------------------------------------------------------------
# Adjacency matrix builder
# ---------------------------------------------------------------------------


def _build_adjacency(n: int) -> torch.Tensor:
    """
    Build a normalised adjacency matrix for a simple linear chain graph
    (station[i] connected to station[i-1] and station[i+1]) with self-loops.

    Normalisation: Â = D^{-1/2} (A + I) D^{-1/2}
    (symmetric normalisation as in Kipf & Welling 2017)
    """
    A = torch.zeros(n, n)
    for i in range(n):
        A[i, i] = 1.0          # self-loop
        if i > 0:
            A[i, i - 1] = 1.0  # predecessor
        if i < n - 1:
            A[i, i + 1] = 1.0  # successor

    # Degree matrix
    degree = A.sum(dim=1)
    D_inv_sqrt = torch.diag(degree ** -0.5)
    adj_norm   = D_inv_sqrt @ A @ D_inv_sqrt
    return adj_norm


# ---------------------------------------------------------------------------
# Singleton model state
# ---------------------------------------------------------------------------

_model:          GCNLSTMModel | None = None
_adj:            torch.Tensor | None = None
model_available: bool = False
load_error:      str | None = None


def _load_model() -> None:
    """Load weights and prepare the model.  Called once at module import."""
    global _model, _adj, model_available, load_error

    if not _MODEL_PATH.exists():
        load_error = f"Model file not found: {_MODEL_PATH}"
        log.error(load_error)
        return

    try:
        state_dict = torch.load(str(_MODEL_PATH), map_location="cpu", weights_only=False)
        net = GCNLSTMModel(
            n_stations  = N_STATIONS,
            in_features = 1,
            gcn_out     = 16,
            lstm_hidden = 32,
            num_layers  = 1,
        )
        net.load_state_dict(state_dict, strict=True)
        net.eval()

        _model = net
        _adj   = _build_adjacency(N_STATIONS)

        # Output-dimension guard: run a dummy forward pass to verify shape.
        try:
            dummy_x = torch.zeros(SEQ_LEN, N_STATIONS, 1)
            with torch.no_grad():
                dummy_out = net(dummy_x, _adj)  # expected [N_STATIONS, 1]
            if dummy_out.shape[-1] != 1 or dummy_out.shape[0] != N_STATIONS:
                load_error = (
                    f"Model output shape mismatch: expected ({N_STATIONS}, 1), "
                    f"got {tuple(dummy_out.shape)}. "
                    f"Retrain for exactly {N_STATIONS} stations."
                )
                log.error(load_error)
                model_available = False
                return
        except Exception as shape_exc:
            load_error = f"Model output-dimension check failed: {shape_exc}"
            log.error(load_error)
            model_available = False
            return

        model_available = True
        log.info("GCN-LSTM delay model loaded from %s", _MODEL_PATH)
    except Exception as exc:
        load_error = f"Failed to load GCN-LSTM model: {exc}"
        log.error(load_error)


# Eager load at import time
_load_model()


# ---------------------------------------------------------------------------
# Public inference API
# ---------------------------------------------------------------------------


def predict_delay(sequence: list[list[float]]) -> list[dict]:
    """
    Run delay inference for a 12-step input sequence.

    Parameters
    ----------
    sequence : list of SEQ_LEN lists, each of length N_STATIONS.
               sequence[t][s] = observed delay (in minutes) for station s
               at time step t.

    Returns
    -------
    list of dicts, one per station:
        { "station": str, "predicted_delay_minutes": float }
    """
    if not model_available or _model is None or _adj is None:
        raise RuntimeError(load_error or "Delay model not available")

    if len(sequence) != SEQ_LEN:
        raise ValueError(
            f"sequence must have exactly {SEQ_LEN} time steps, got {len(sequence)}"
        )
    for t, step in enumerate(sequence):
        if len(step) != N_STATIONS:
            raise ValueError(
                f"Each time step must have {N_STATIONS} values (one per station); "
                f"step {t} has {len(step)}"
            )

    # Build tensor [seq_len, N_stations, 1]
    arr = np.array(sequence, dtype=np.float32)      # [12, 5]
    x   = torch.tensor(arr).unsqueeze(-1)           # [12, 5, 1]

    with torch.no_grad():
        out = _model(x, _adj)  # [N_stations, 1]

    delays = out.squeeze(-1).numpy()  # [N_stations]

    return [
        {
            "station":                   STATIONS[i],
            "predicted_delay_minutes":   round(float(delays[i]), 4),
        }
        for i in range(N_STATIONS)
    ]
