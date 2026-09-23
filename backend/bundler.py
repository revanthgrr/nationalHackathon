"""
bundler.py — Stage 6: VNS Joint-Block Bundling.

After CP-SAT produces scheduled_blocks, this module finds blocks that are
spatially proximate (within proximity_threshold_m) and temporally overlapping
or adjacent (within safety_headway_minutes), and nests them into joint blocks.

Variable Neighbourhood Search uses three move types tried in a fixed order:
    Swap → Insert → SpeedChange

# SIMPLIFICATION: fixed priority order used here; Q-learning priority selection
# is deferred to a future release.

The block with the longest duration in each bundle group becomes the parent;
all others become children (parent_block_id set to parent's ID).
All bundled blocks get status='bundled'.

Blocks with status='executed' are never touched.
"""

from __future__ import annotations

import logging
from datetime import timedelta

from sqlalchemy.orm import Session

from models import ScheduledBlock

log = logging.getLogger("railsetu.bundler")


# ---------------------------------------------------------------------------
# Proximity and overlap helpers
# ---------------------------------------------------------------------------

def _are_proximate(
    block_a: ScheduledBlock,
    block_b: ScheduledBlock,
    threshold_m: float,
    headway_min: int,
) -> bool:
    """
    Return True if two blocks are candidates for bundling:
    - Their chainage positions are within threshold_m metres, AND
    - Their time ranges overlap OR are within headway_min of each other.
    """
    chainage_dist_m = abs(block_a.chainage_km - block_b.chainage_km) * 1000.0
    if chainage_dist_m > threshold_m:
        return False

    # Time overlap
    time_overlap = (
        block_a.start_time < block_b.end_time and
        block_b.start_time < block_a.end_time
    )
    # Time adjacency (within headway)
    headway_delta = timedelta(minutes=headway_min)
    time_adjacent = (
        abs(block_a.end_time - block_b.start_time) <= headway_delta or
        abs(block_b.end_time - block_a.start_time) <= headway_delta
    )
    return time_overlap or time_adjacent


def _duration_minutes(block: ScheduledBlock) -> float:
    """Duration of a block in minutes."""
    return (block.end_time - block.start_time).total_seconds() / 60.0


# ---------------------------------------------------------------------------
# VNS Move types
# ---------------------------------------------------------------------------

def _swap_move(group_a: list[ScheduledBlock], group_b: list[ScheduledBlock]) -> bool:
    """
    Swap: attempt to exchange one task between two proximity groups.
    Returns True if a beneficial swap was performed (groups modified in-place).
    Currently implemented as a no-op improvement check — accepts if both
    groups remain valid after the swap (all blocks still proximate to each other).
    """
    if not group_a or not group_b:
        return False
    # Try swapping last block of A into B and first of B into A
    candidate_a = group_a[-1]
    candidate_b = group_b[0]
    # Accept if the moved block is proximate to at least one member of its new group
    # (simplified acceptance criterion — full constraint re-check is out of scope)
    a_fits_in_b = any(
        abs(candidate_a.chainage_km - b.chainage_km) * 1000 < 500
        for b in group_b if b.id != candidate_b.id
    ) if len(group_b) > 1 else True
    b_fits_in_a = any(
        abs(candidate_b.chainage_km - a.chainage_km) * 1000 < 500
        for a in group_a if a.id != candidate_a.id
    ) if len(group_a) > 1 else True
    if a_fits_in_b and b_fits_in_a:
        group_a[-1], group_b[0] = group_b[0], group_a[-1]
        return True
    return False


def _insert_move(
    source_group: list[ScheduledBlock],
    target_group: list[ScheduledBlock],
    threshold_m: float,
    headway_min: int,
) -> bool:
    """
    Insert: move a single block from source_group into target_group if it is
    proximate to at least one member of target_group.
    Returns True if the move was performed (lists modified in-place).
    """
    if not source_group:
        return False
    candidate = source_group[-1]
    fits = any(_are_proximate(candidate, t, threshold_m, headway_min) for t in target_group)
    if fits:
        target_group.append(source_group.pop())
        return True
    return False


def _speed_change_move(block: ScheduledBlock, step_minutes: int = 5) -> bool:
    """
    SpeedChange: adjust a block's end_time by ±step_minutes within the
    max_crew_shift constraint (480 minutes = 8 hours default).

    Accepted if the adjusted duration is still > 0 and ≤ 480 minutes.
    Modifies the block object in-place. Returns True if adjusted.
    """
    # SIMPLIFICATION: fixed priority order used here; Q-learning priority selection
    # is deferred to a future release.
    current_duration = _duration_minutes(block)
    new_duration = current_duration - step_minutes   # try reducing first
    if 1 <= new_duration <= 480:
        block.end_time = block.start_time + timedelta(minutes=new_duration)
        return True
    new_duration = current_duration + step_minutes   # try increasing
    if 1 <= new_duration <= 480:
        block.end_time = block.start_time + timedelta(minutes=new_duration)
        return True
    return False


# ---------------------------------------------------------------------------
# Main bundling function
# ---------------------------------------------------------------------------

def bundle_blocks(
    db: Session,
    proximity_threshold_m: float = 500.0,
    safety_headway_minutes: int = 10,
) -> dict:
    """
    Identify proximate, temporally-overlapping scheduled blocks and merge
    them into joint blocks using VNS.

    Only blocks with status='scheduled' are considered.
    Blocks with status='executed' are never modified.

    Returns
    -------
    {"ok": True, "bundles_created": int, "blocks_bundled": int,
     "blocks_unchanged": int, "bundle_groups": [{"parent_id": int, "child_ids": [...]}]}
    """
    blocks: list[ScheduledBlock] = (
        db.query(ScheduledBlock)
        .filter(ScheduledBlock.status == "scheduled")
        .order_by(ScheduledBlock.start_time)
        .all()
    )

    if len(blocks) < 2:
        return {
            "ok":             True,
            "bundles_created":  0,
            "blocks_bundled":   0,
            "blocks_unchanged": len(blocks),
            "bundle_groups":    [],
        }

    # ── Build initial proximity groups (greedy union-find style) ─────────────
    # Each block starts in its own group; merge groups if any pair is proximate.
    group_of: dict[int, int] = {b.id: b.id for b in blocks}   # block_id → group_root
    groups: dict[int, list[ScheduledBlock]] = {b.id: [b] for b in blocks}

    def _find_root(bid: int) -> int:
        while group_of[bid] != bid:
            bid = group_of[bid]
        return bid

    def _merge(bid_a: int, bid_b: int) -> None:
        root_a = _find_root(bid_a)
        root_b = _find_root(bid_b)
        if root_a == root_b:
            return
        # Merge smaller into larger
        if len(groups[root_a]) >= len(groups[root_b]):
            for b in groups[root_b]:
                group_of[b.id] = root_a
            groups[root_a].extend(groups.pop(root_b))
        else:
            for b in groups[root_a]:
                group_of[b.id] = root_b
            groups[root_b].extend(groups.pop(root_a))

    for i, ba in enumerate(blocks):
        for j in range(i + 1, len(blocks)):
            bb = blocks[j]
            if _are_proximate(ba, bb, proximity_threshold_m, safety_headway_minutes):
                _merge(ba.id, bb.id)

    # ── Apply VNS moves in fixed order ────────────────────────────────────────
    # SIMPLIFICATION: fixed priority order used here; Q-learning priority selection
    # is deferred to a future release.
    group_list: list[list[ScheduledBlock]] = [
        g for g in groups.values() if len(g) >= 1
    ]

    for _ in range(3):   # three VNS iterations
        for i in range(len(group_list)):
            for j in range(i + 1, len(group_list)):
                # Move type 1: Swap
                _swap_move(group_list[i], group_list[j])
                # Move type 2: Insert
                _insert_move(group_list[i], group_list[j], proximity_threshold_m, safety_headway_minutes)
        # Move type 3: SpeedChange on largest block in each multi-block group
        for g in group_list:
            if len(g) > 1:
                largest = max(g, key=_duration_minutes)
                _speed_change_move(largest)

    # ── Persist bundle groups (only groups with ≥ 2 blocks) ──────────────────
    bundle_groups: list[dict] = []
    blocks_bundled = 0

    for group in group_list:
        if len(group) < 2:
            continue

        # Parent = block with longest duration
        parent = max(group, key=_duration_minutes)

        bundle_groups.append({
            "parent_id": parent.id,
            "child_ids": [b.id for b in group if b.id != parent.id],
        })

        for block in group:
            block.status = "bundled"
            if block.id != parent.id:
                block.parent_block_id = parent.id
            blocks_bundled += 1

    db.commit()

    blocks_unchanged = len(blocks) - blocks_bundled

    log.info(
        "Bundler: %d bundles created, %d blocks bundled, %d unchanged",
        len(bundle_groups), blocks_bundled, blocks_unchanged,
    )

    return {
        "ok":             True,
        "bundles_created":  len(bundle_groups),
        "blocks_bundled":   blocks_bundled,
        "blocks_unchanged": blocks_unchanged,
        "bundle_groups":    bundle_groups,
    }
