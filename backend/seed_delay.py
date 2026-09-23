"""
seed_delay.py — Inserts backdated delay records to populate the 12×5 window.
Run from backend/ directory.
"""
import sys
sys.path.insert(0, '.')

from datetime import datetime, timedelta, timezone

from database import SessionLocal
from models import RawIngestionRecord
from services.delay_service import build_delay_window
from services.delay_service import predict_latest

STATIONS    = ['SC', 'MJF', 'AWL', 'GHKT', 'BBN']
BASE_DELAYS = [2.0, 1.5, 3.0, 2.5, 1.0]

db = SessionLocal()
try:
    now = datetime.now(timezone.utc)

    inserted = 0
    for step in range(12):
        # step 0 = oldest, step 11 = newest; 2-min offset inside each bin
        obs_time = now - timedelta(minutes=(11 - step) * 5 + 2)
        for s_idx, station in enumerate(STATIONS):
            delay_val = round(BASE_DELAYS[s_idx] + step * 0.1, 2)
            rec = RawIngestionRecord(
                source_system='SMMS',
                station_code=station,
                observation_time=obs_time,
                payload={'delay_minutes': delay_val, 'step': step},
                chainage_processed=False,
            )
            db.add(rec)
            inserted += 1

    db.commit()
    print(f'Inserted {inserted} backdated delay records across 12 time bins')

    # Test window builder
    print('\n--- Building delay window ---')
    result = build_delay_window(db)
    ok = result.get('ok')
    print(f'ok = {ok}')
    if ok:
        seq = result['sequence']
        print(f'Shape: {len(seq)} x {len(seq[0])}')
        print(f'First row : {seq[0]}')
        print(f'Last row  : {seq[-1]}')
    else:
        print('Detail:', result.get('detail'))

    # Run actual prediction + persist
    if ok:
        print('\n--- Running delay prediction + persist ---')
        pred_result = predict_latest(db)
        ok2 = pred_result.get('ok')
        print(f'ok = {ok2}')
        if ok2:
            print(f'run_id     = {pred_result["run_id"]}')
            print(f'predictions:')
            for p in pred_result['predictions']:
                print(f'  {p["station"]}: {p["predicted_delay_minutes"]:.4f} min')
        else:
            print('Error:', pred_result.get('reason'))
finally:
    db.close()
