"""Expose compact evidence through GitHub check annotations, not only log blobs.

Usage: publish-summaries.py ROOT [independent-ledger.json]
Raw PCM remains in workflow artifacts. No summary is treated as a pass without
its reported integrity/fidelity outcomes. One notice per protocol/browser keeps
annotation count small; failures and startup anomalies are not suppressed.
"""
import json, pathlib, sys
root=pathlib.Path(sys.argv[1])
if len(sys.argv)>2:
    rows=json.loads(pathlib.Path(sys.argv[2]).read_text())
else:
    rows=[]
    for path in sorted(root.rglob('*.summary.json')):
        r=json.loads(path.read_text()); v2='readiness' in r
        rows.append({'file':str(path.relative_to(root)), 'protocol':'readiness-v2' if v2 else 'legacy',
            'browserVersion':r['browserVersion'], 'playwrightVersion':r.get('playwrightVersion'), 'runId':r.get('runId'),
            'passed':r['passed'], 'readiness':r.get('readiness'), 'startupAnomalies':r.get('startupAnomalies'),
            'postReadyAnomalies':r.get('postReadyAnomalies'), 'frameErrors':r.get('frameErrors'),
            'firstFailure':r.get('firstFailure'), 'firstPcmError':r.get('firstPcmError'),
            'measurementIntegrity':r.get('measurementIntegrity'), 'fidelity':r.get('fidelity'),
            'missing':r.get('missing',r.get('missingSamples')), 'duplicates':r.get('duplicates',r.get('duplicatedSamples')),
            'conflicts':r.get('conflicts',r.get('conflictingSamples')), 'maxAbsError':r['maxAbsError'], 'rmsError':r['rmsError'],
            'sequenceErrors':r['sequenceErrors'], 'checksumFailures':r['checksumFailures'], 'aliasCount':r['aliasCount'],
            'changedBlocks':r['changedBlocks'], 'layoutErrors':r.get('layoutErrors'), 'runIdErrors':r.get('runIdErrors'),
            'conflictingTimestampBlocks':r.get('conflictingTimestampBlocks'), 'expectedSamples':r.get('expectedSamples',r.get('expectedWindowSamples')),
            'compared':r.get('compared',r.get('comparedSamples')), 'quantumSizes':r['quantumSizes'],
            'ready':r.get('ready'),'armed':r.get('armed'),'window':r.get('window'), 'environment':r['environment'],
            'rawSha256':r.get('rawSha256')})
groups={}
for r in rows: groups.setdefault((r['protocol'],r['browserVersion']),[]).append(r)
for (protocol,browser), records in groups.items():
    # Chunk if needed: do not truncate any run or first-failure detail.
    for start in range(0,len(records),9):
        message=json.dumps(records[start:start+9],separators=(',',':'))
        message=message.replace('%','%25').replace('\r','%0D').replace('\n','%0A')
        print(f'::notice title=Capture evidence {protocol} {browser} chunk {start//9}::{message}')
for path in root.rglob('environment.txt'):
    message=path.read_text().replace('%','%25').replace('\r','%0D').replace('\n','%0A')
    print(f'::notice title=Capture environment::{message}')
