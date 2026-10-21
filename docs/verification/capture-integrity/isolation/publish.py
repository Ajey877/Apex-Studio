"""Lossless hosted summaries; raw recordings stay in workflow artifacts."""
import base64,gzip,hashlib,json,os,pathlib,sys
root=pathlib.Path(sys.argv[1]); rows=[]
independent={r['rawSha256']:r for r in json.loads((root/'independent.json').read_text())}
for path in sorted(root.glob('*.summary.json')):
    row=json.loads(path.read_text()); row['independent']=independent[row['rawSha256']];rows.append(row)
(root/'ledger.json').write_text(json.dumps(rows,indent=2))
text=json.dumps(rows,separators=(',',':')).encode();sha=hashlib.sha256(text).hexdigest()
packed=base64.b64encode(gzip.compress(text,mtime=0)).decode(); chunks=[packed[i:i+2500] for i in range(0,len(packed),2500)]
assert len(chunks)<=40
start=int(os.environ.get('PART_START','0'));stop=int(os.environ.get('PART_END','10'))
for i,chunk in enumerate(chunks):
    if start<=i<stop:
        envelope=json.dumps({'sha256':sha,'part':i,'parts':len(chunks),'gzipBase64':chunk},separators=(',',':'))
        assert len(envelope)<4096
        print(f'::notice title=Isolation payload {sha[:12]} part {i}::{envelope}')
if start==0:
    report=['# Standalone frame isolation', '| Profile | Runs | Startup anomalies | Post-ready anomalies | Source coverage | Fidelity |', '|---|---:|---:|---:|---:|---:|']
    for profile in ['short','long','workload']:
        group=[r for r in rows if r['profile']==profile]
        report.append(f"| {profile} | {len(group)} | {sum(not r['startupContinuous'] for r in group)} | {sum(not r['postReadyContinuous'] for r in group)} | {sum(r['sourceCoverage'] for r in group)} | {sum(r['fidelity'] for r in group)} |")
    report+=['','Every failing run is retained in ledger.json and its individual raw file. Baseline-contract outcomes for deliberate controls remain separate; job color is not a substitute for the per-run results.']
    summary=os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary,'a') as f:f.write('\n'.join(report)+'\n')
    else: print('\n'.join(report))
