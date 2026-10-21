"""Expose compact evidence through GitHub check annotations, not only log blobs.

Usage: publish-summaries.py ROOT [independent-ledger.json]
Raw PCM remains in workflow artifacts. No summary is treated as a pass without
its reported integrity/fidelity outcomes. One notice per protocol/browser keeps
annotation count small; failures and startup anomalies are not suppressed.
"""
import hashlib, json, pathlib, sys
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
# GitHub silently truncates individual notice messages at 4096 characters.
# Preserve compact full-run metrics in hash-verified, reconstructible fragments.
compact=[]
for r in rows:
    if 'archivedTestPassed' in r:
        compact.append({k:r.get(k) for k in [
            'file','protocol','browserVersion','playwrightVersion','rawSha256','rawHashMatchesSummary',
            'blocks','quantumSizes','startFrame','endFrame','sourceStartFrame','sourceFrames',
            'expectedSamples','comparedSamples','anomalies','readiness','measurementIntegrity','sourceFidelity',
            'maxAbsError','rmsError','silenceMax','missing','duplicates','conflicts','conflictingTimestampBlocks',
            'checksumErrors','sequenceErrors','layoutErrors','runIdErrors','aliasCount','changedBlocks',
            'checksumFailuresReported','nonfiniteSamples','firstPcmError','archivedTestPassed'
        ]})
    else:
        # This is the existing test summary, not independent raw verification.
        compact.append(r)
payload=json.dumps(compact,separators=(',',':'))
digest=hashlib.sha256(payload.encode()).hexdigest()
chunks=[payload[i:i+1800] for i in range(0,len(payload),1800)]
for i,text in enumerate(chunks):
    envelope=json.dumps({'sha256':digest,'part':i,'parts':len(chunks),'text':text},separators=(',',':'))
    assert len(envelope.encode()) < 4096
    message=envelope.replace('%','%25').replace('\r','%0D').replace('\n','%0A')
    print(f'::notice title=Capture payload {digest[:12]} part {i}::{message}')
for path in root.rglob('environment.txt'):
    message=path.read_text().replace('%','%25').replace('\r','%0D').replace('\n','%0A')
    print(f'::notice title=Capture environment::{message}')
