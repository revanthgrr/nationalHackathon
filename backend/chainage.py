"""
chainage.py — Stage 2: Location / Chainage Mapping logic.

Converts whatever location signal is present on a RawIngestionRecord into a
single chainage_km value — a linear kilometre-marker along the track.

Three input types are handled:
  1. (latitude, longitude) — GPS fix   → project_gps_to_chainage()
  2. station_code          — station   → STATION_CHAINAGE_MAP lookup
  3. mast_id               — OHE mast  → MAST_CHAINAGE_MAP lookup

The public entry-point is resolve_chainage(record), which returns
  (chainage_km: float | None, error_reason: str | None).
It never raises for expected failure cases (unknown code, no location data).
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from shapely.geometry import LineString, Point

if TYPE_CHECKING:
    from models import RawIngestionRecord

log = logging.getLogger("railsetu.chainage")

# ---------------------------------------------------------------------------
# Reference track alignment
# ---------------------------------------------------------------------------
#
# PLACEHOLDER — replace with real GIS track-centreline data (e.g. exported
# from OpenRailwayMap / Railways Board alignment files) before production use.
#
# This hardcoded polyline represents an approximate ~20 km stretch of the
# Secunderabad–Kazipet mainline (South Central Railway, Hyderabad region),
# running roughly north-east from Secunderabad Junction (SC) toward Malkajgiri
# and on to Ghatkesar.
#
# Each tuple: (latitude_dd, longitude_dd, chainage_km_from_SC)
# Coordinates were read off OSM / Google Maps and are approximate to ~50 m.
# ---------------------------------------------------------------------------

_TRACK_REFERENCE_POINTS: list[tuple[float, float, float]] = [
    # (lat,      lon,       chainage_km)  — landmark
    (17.4344,  78.5013,   0.00),   # Secunderabad Junction (SC)
    (17.4419,  78.5102,   1.20),   # SC Yard north throat
    (17.4497,  78.5218,   2.50),   # Malkajgiri south approach
    (17.4553,  78.5301,   3.40),   # Malkajgiri Station (MJF) area
    (17.4610,  78.5389,   4.30),   # Malkajgiri north
    (17.4668,  78.5478,   5.25),   # Tirumalagiri area
    (17.4725,  78.5567,   6.20),   # Between MJF and BGPR
    (17.4781,  78.5654,   7.10),   # Begumpet Road crossing
    (17.4836,  78.5740,   8.00),   # Yapral area
    (17.4889,  78.5824,   8.90),   # Alwal south approach
    (17.4941,  78.5908,   9.80),   # Alwal Station (AWL) area
    (17.4992,  78.5991,  10.70),   # Alwal north
    (17.5044,  78.6074,  11.60),   # Safilguda area
    (17.5097,  78.6158,  12.55),   # Dammaiguda approach
    (17.5150,  78.6243,  13.50),   # Dammaiguda area
    (17.5203,  78.6329,  14.45),   # Between Dammaiguda and GHKT
    (17.5255,  78.6414,  15.40),   # Ghatkesar south approach
    (17.5307,  78.6499,  16.35),   # Ghatkesar Station (GHKT) area
    (17.5358,  78.6583,  17.25),   # Ghatkesar north
    (17.5408,  78.6666,  18.15),   # Between GHKT and Bibinagar
    (17.5457,  78.6748,  19.00),   # Bibinagar south approach
    (17.5505,  78.6830,  19.90),   # Bibinagar Station (BBN) area
    (17.5551,  78.6911,  20.75),   # End of reference segment
]

# Build the Shapely LineString once at module import time.
# Shapely works in (x, y) = (longitude, latitude) order.
_TRACK_LINE: LineString = LineString(
    [(lon, lat) for lat, lon, _ in _TRACK_REFERENCE_POINTS]
)

# Parallel list of cumulative chainage values for interpolation.
_CHAINAGE_VALUES: list[float] = [ch for _, _, ch in _TRACK_REFERENCE_POINTS]
_TOTAL_CHAINAGE: float = _CHAINAGE_VALUES[-1]  # 20.75 km

# ---------------------------------------------------------------------------
# Station lookup table
# ---------------------------------------------------------------------------
#
# Maps Indian Railways station codes (upper-case) to chainage_km along the
# reference line above.  Add real values as more stations become active.
# ---------------------------------------------------------------------------

STATION_CHAINAGE_MAP: dict[str, float] = {
    "SC":    0.00,   # Secunderabad Junction
    "MJF":   3.40,   # Malkajgiri
    "AWL":   9.80,   # Alwal
    "GHKT": 16.35,   # Ghatkesar
    "BBN":  19.90,   # Bibinagar
}

# ---------------------------------------------------------------------------
# OHE / traction mast lookup table
# ---------------------------------------------------------------------------
#
# Maps mast identifiers to chainage_km.  Mast IDs are installation-specific;
# these are synthetic but consistent with the reference line range.
# ---------------------------------------------------------------------------

MAST_CHAINAGE_MAP: dict[str, float] = {
    "SC-M-001":    0.45,
    "SC-M-002":    0.90,
    "MJF-M-001":   3.80,
    "MJF-M-002":   4.60,
    "AWL-M-001":   9.20,
    "AWL-M-002":  10.30,
    "GHKT-M-001": 15.80,
    "GHKT-M-002": 17.00,
    "BBN-M-001":  19.40,
}


# ---------------------------------------------------------------------------
# GPS → chainage projection
# ---------------------------------------------------------------------------

def project_gps_to_chainage(lat: float, lon: float) -> float:
    """
    Project a GPS fix onto the reference track line and return chainage_km.

    Algorithm
    ---------
    1. Build a Shapely Point from the GPS coordinate.
    2. Use LineString.project() to find the distance along the line to the
       nearest foot-of-perpendicular — this is a true geometric projection,
       not a nearest-node snap.
    3. Walk the reference segments to find which segment the foot falls on,
       then interpolate chainage_km linearly within that segment.

    Clamping
    --------
    If the projected point falls outside the reference line's extent, a
    WARNING is logged and the nearest endpoint chainage is returned rather
    than raising.

    Parameters
    ----------
    lat, lon : WGS-84 decimal degrees

    Returns
    -------
    float : chainage_km along the reference track
    """
    point = Point(lon, lat)  # Shapely is (x=lon, y=lat)

    # Distance along the line to the projected foot, in the line's CRS units
    # (decimal degrees here — fine for interpolation since we immediately
    # convert to chainage_km via the reference waypoints).
    proj_dist = _TRACK_LINE.project(point)          # absolute distance along line
    line_len  = _TRACK_LINE.length                   # total line length in degree-units

    # Epsilon for floating-point boundary comparisons
    eps = 1e-9

    # Clamp and warn if the point projects before the line start.
    if proj_dist < eps:
        if point.distance(_TRACK_LINE) > 0.01:      # roughly >1 km off-track at this lat
            log.warning(
                "GPS (%.6f, %.6f) projects before the start of the reference line; "
                "clamping chainage to %.2f km",
                lat, lon, _CHAINAGE_VALUES[0],
            )
        return _CHAINAGE_VALUES[0]

    # Clamp and warn if the point projects beyond the line end.
    if proj_dist >= line_len - eps:
        if point.distance(_TRACK_LINE) > 0.01:
            log.warning(
                "GPS (%.6f, %.6f) projects beyond the end of the reference line; "
                "clamping chainage to %.2f km",
                lat, lon, _CHAINAGE_VALUES[-1],
            )
        return _CHAINAGE_VALUES[-1]

    # Walk segments to find the one containing the projected foot, then
    # linearly interpolate chainage_km within that segment.
    accumulated = 0.0
    for i in range(len(_TRACK_REFERENCE_POINTS) - 1):
        seg_lon_0, seg_lat_0 = _TRACK_LINE.coords[i]
        seg_lon_1, seg_lat_1 = _TRACK_LINE.coords[i + 1]
        seg = LineString([(seg_lon_0, seg_lat_0), (seg_lon_1, seg_lat_1)])
        seg_len = seg.length

        if accumulated + seg_len >= proj_dist - eps:
            frac = (proj_dist - accumulated) / seg_len if seg_len > eps else 0.0
            ch_start = _CHAINAGE_VALUES[i]
            ch_end   = _CHAINAGE_VALUES[i + 1]
            chainage = ch_start + frac * (ch_end - ch_start)
            log.debug(
                "GPS (%.6f, %.6f) -> segment %d/%d, frac=%.4f -> chainage=%.3f km",
                lat, lon, i, len(_TRACK_REFERENCE_POINTS) - 2, frac, chainage,
            )
            return round(chainage, 3)

        accumulated += seg_len

    # Should be unreachable, but fall back to last chainage to be safe.
    log.warning("GPS projection fell through segment loop — returning end chainage.")
    return _CHAINAGE_VALUES[-1]


# ---------------------------------------------------------------------------
# Unified resolver
# ---------------------------------------------------------------------------

def resolve_chainage(
    record: "RawIngestionRecord",
) -> tuple[float | None, str | None]:
    """
    Determine chainage_km for a single RawIngestionRecord.

    Detection order
    ---------------
    1. latitude + longitude  -> project_gps_to_chainage()
    2. station_code          -> STATION_CHAINAGE_MAP lookup
    3. mast_id               -> MAST_CHAINAGE_MAP lookup

    Returns
    -------
    (chainage_km, None)        — success
    (None, error_reason: str)  — failure; reason is one of:
                                   "unknown_station_code"
                                   "unknown_mast_id"
                                   "no_location_data"

    Never raises for expected failure cases (bad code, missing data).
    """
    # --- GPS ---
    if record.latitude is not None and record.longitude is not None:
        chainage = project_gps_to_chainage(record.latitude, record.longitude)
        log.info(
            "Record id=%s: GPS (%.6f, %.6f) -> chainage=%.3f km",
            record.id, record.latitude, record.longitude, chainage,
        )
        return chainage, None

    # --- Station code ---
    if record.station_code is not None:
        code = record.station_code.strip().upper()
        if code in STATION_CHAINAGE_MAP:
            chainage = STATION_CHAINAGE_MAP[code]
            log.info(
                "Record id=%s: station_code=%s -> chainage=%.3f km",
                record.id, code, chainage,
            )
            return chainage, None
        else:
            log.warning(
                "Record id=%s: station_code=%s not found in lookup map.",
                record.id, code,
            )
            return None, "unknown_station_code"

    # --- Mast ID ---
    if record.mast_id is not None:
        mast = record.mast_id.strip().upper()
        if mast in MAST_CHAINAGE_MAP:
            chainage = MAST_CHAINAGE_MAP[mast]
            log.info(
                "Record id=%s: mast_id=%s -> chainage=%.3f km",
                record.id, mast, chainage,
            )
            return chainage, None
        else:
            log.warning(
                "Record id=%s: mast_id=%s not found in lookup map.",
                record.id, mast,
            )
            return None, "unknown_mast_id"

    # --- No location data at all ---
    log.error(
        "Record id=%s has no location field populated (lat/lon, station_code, "
        "or mast_id). This should have been caught at ingest time.",
        record.id,
    )
    return None, "no_location_data"
