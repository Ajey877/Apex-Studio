"""Read-only extraction of original failure records and runner metadata."""
import base64,gzip,hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]); result={'environments':[]}
for p in sorted(root.rglob('environment.txt')):
    result['environments'].append({'path':str(p.relative_to(root)),'text':p.read_text()})
for p in root.rglob('*73c39967-ab8c-4d9e-a1c9-c6a74b68023b.json.gz'):
    data=p.read_bytes();raw=json.loads(gzip.decompress(data));neighbors=[]
    for r in raw['records']:
        if 31<=r['sequence']<=37:
            neighbors.append(r) # Includes exact base64 PCM, not a reconstruction.
    duplicate=[r for r in neighbors if r['frame']==5248]
    result['historicalFailure']={'path':str(p.relative_to(root)),'rawSha256':hashlib.sha256(data).hexdigest(),
       'runId':raw['runId'],'window':raw['window'],'markers':raw['markers'],'records':neighbors,
       'samePcm':len(duplicate)==2 and duplicate[0]['pcmBase64']==duplicate[1]['pcmBase64']}
assert 'historicalFailure' in result
payload=json.dumps(result,separators=(',',':')).encode();sha=hashlib.sha256(payload).hexdigest()
pathlib.Path('inspection-results').mkdir(exist_ok=True)
pathlib.Path('inspection-results/history.json').write_bytes(payload)
b64=base64.b64encode(gzip.compress(payload,mtime=0)).decode();chunks=[b64[i:i+2500] for i in range(0,len(b64),2500)]
assert len(chunks)<=10
for i,chunk in enumerate(chunks):
    print('::notice title=Isolation history::'+json.dumps({'sha256':sha,'part':i,'parts':len(chunks),'gzipBase64':chunk},separators=(',',':')))
