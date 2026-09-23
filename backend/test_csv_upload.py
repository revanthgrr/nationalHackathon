import requests, json

with open('test_upload.csv', 'rb') as f:
    r = requests.post(
        'http://localhost:8000/ingest/csv',
        files={'file': ('test_upload.csv', f, 'text/csv')}
    )

print('Status:', r.status_code)
data = r.json()
print(json.dumps(data, indent=2))
