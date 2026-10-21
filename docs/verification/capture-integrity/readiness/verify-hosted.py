# Independent stdlib verifier for archived raw PCM; no production imports.
import array, gzip, hashlib, json, math, pathlib, sys
root=pathlib.Path(sys.argv[1]); output=pathlib.Path(sys.argv[2]); sources={}; results=[]
assert sys.byteorder=='little'
def source(n):
    if n not in sources:
        x=0x7135ace1; samples=array.array('f')
        for _ in range(n):
            x ^= (x<<13)&0xffffffff; x ^= x>>17; x ^= (x<<5)&0xffffffff; x &= 0xffffffff
            samples.append((x/4294967296-.5)*.5)
        sources[n]=samples
    return sources[n]
for path in sorted(root.rglob('*.json.gz')):
    raw=path.read_bytes(); run=json.loads(gzip.decompress(raw)); records=run['records']
    is_ready=run.get('protocol')=='readiness-v2'
    w=run['window'] if is_ready else run
    markers=run.get('markers',run.get('messages',[]))
    ready=next((m for m in markers if m['kind']=='ready'),None)
    armed=next((m for m in markers if m['kind']=='armed'),None)
    end=next((m for m in markers if m['kind']=='end'),None)
    begin,finish=w['startFrame'],w['endFrame']; scheduled=w['sourceStartFrame']; expected=source(run['sourceFrames'])
    seen=bytearray(finish-begin); selected=array.array('f',[0])*(finish-begin)
    checksum_errors=sequence_errors=layout_errors=duplicates=conflicts=conflicting_blocks=0
    missing=max_error=square=compared=silence_peak=nonfinite=0; first_error=None; anomalies=[]; frames={}; previous=None
    id_errors=0
    for i,r in enumerate(records):
        data=__import__('base64').b64decode(r['pcmBase64']); pcm=array.array('f'); pcm.frombytes(data)
        h=2166136261
        for b in data: h=((h^b)*16777619)&0xffffffff
        checksum_errors+=h!=r['checksum']; sequence_errors+=r['sequence']!=i
        layout_errors += len(pcm)!=r['quantum'] or any(n!=r['quantum'] for n in r['inputLengths'])
        if is_ready:
            id_errors+=r['runId']!=run['runId']
            layout_errors += (r['outputChannels']!=1 or r['outputLengths']!=[r['quantum']] or r['sampleRate']!=run['sampleRate'] or r['mainContextState']!='running')
        if previous is not None and r['frame']!=previous['frame']+previous['quantum']:
            anomalies.append({'sequence':r['sequence'],'expectedFrame':previous['frame']+previous['quantum'],'actualFrame':r['frame'],
                              'phase':('post-ready' if r['sequence']>ready['sequence'] else 'startup') if ready else ('pre-window' if r['frame']<begin else 'window')})
        if r['frame'] in frames and data!=frames[r['frame']]: conflicting_blocks+=1
        frames[r['frame']]=data; previous=r
        for j,sample in enumerate(pcm):
            frame=r['frame']+j; k=frame-begin
            if not 0<=k<len(seen): continue
            if seen[k]:
                duplicates+=1; conflicts+=selected[k]!=sample
            seen[k]=1; selected[k]=sample
            si=frame-scheduled; reference=expected[si] if 0<=si<len(expected) else 0
            error=abs(sample-reference)
            if error and first_error is None: first_error={'frame':frame,'sequence':r['sequence'],'sourceIndex':si,'actual':sample,'expected':reference,'error':error}
            if not math.isfinite(error): nonfinite+=1
            max_error=max(max_error,error); square+=error*error; compared+=1
            if not 0<=si<len(expected): silence_peak=max(silence_peak,abs(sample))
    missing=seen.count(0)
    proof=records[ready['sequence']-31:ready['sequence']+1] if ready else []
    readiness=bool(ready and ready['required']==32 and ready['streak']>=32 and len(proof)==32 and all(b['frame']==a['frame']+a['quantum'] for a,b in zip(proof,proof[1:])) and ready['endFrame']==proof[-1]['frame']+proof[-1]['quantum']) if is_ready else None
    end_valid=bool(end and end.get('blocks',end.get('sequence'))==len(records) and end['frame']+end['quantum']>=finish)
    metadata_match=bool(not (checksum_errors or sequence_errors or layout_errors or id_errors or run['aliasCount'] or run['changedBlocks'] or run['checksumFailures']))
    post=[a for a in anomalies if a['phase']=='post-ready'] if is_ready else [a for a in anomalies if a['phase']=='window']
    integrity=bool(metadata_match and not (missing or duplicates or conflicts or post) and end_valid and compared==len(seen))
    if is_ready:
        integrity &= bool(armed and not armed['tooLate'] and armed['frame']<begin and w['scheduledAtFrame']>=ready['endFrame'] and begin>ready['endFrame'])
        id_errors+=sum(m['runId']!=run['runId'] for m in markers)
        integrity &= id_errors==0
    summary=json.loads(path.with_name(path.name.replace('.json.gz','.summary.json')).read_text())
    hash_matches=summary.get('rawSha256',hashlib.sha256(raw).hexdigest())==hashlib.sha256(raw).hexdigest()
    results.append({'file':str(path.relative_to(root)), 'protocol':'readiness-v2' if is_ready else 'legacy', 'runId':run.get('runId'),
        'browserVersion':run['browserVersion'],'playwrightVersion':run.get('playwrightVersion'), 'environment':run['environment'],
        'rawSha256':hashlib.sha256(raw).hexdigest(),'rawHashMatchesSummary':hash_matches,'blocks':len(records),'quantumSizes':sorted({r['quantum'] for r in records}),
        'startFrame':begin,'endFrame':finish,'sourceStartFrame':scheduled,'sourceFrames':len(expected),'expectedSamples':len(seen),'comparedSamples':compared,
        'anomalies':anomalies,'readiness':readiness,'ready':ready,'armed':armed,'end':end,'measurementIntegrity':bool(integrity),
        'sourceFidelity':nonfinite==0 and max_error==0 and silence_peak==0, 'nonfiniteSamples':nonfinite, 'maxAbsError':max_error,'rmsError':math.sqrt(square/max(1,compared)),'silenceMax':silence_peak,
        'missing':missing,'duplicates':duplicates,'conflicts':conflicts,'conflictingTimestampBlocks':conflicting_blocks,
        'checksumErrors':checksum_errors,'sequenceErrors':sequence_errors,'layoutErrors':layout_errors,'runIdErrors':id_errors,
        'aliasCount':run['aliasCount'],'changedBlocks':run['changedBlocks'],'checksumFailuresReported':run['checksumFailures'],
        'firstPcmError':first_error,'archivedTestPassed':summary['passed']})
output.write_text(json.dumps(results,indent=2)); print(f'Independently verified {len(results)} raw captures -> {output}')
