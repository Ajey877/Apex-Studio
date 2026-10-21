import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeIsolation } from './analyze';
function fixture() {
  const id='test';
  return {runId:id,contextId:id,mode:'lead',lifecycle:[],requiredQuanta:32,sampleRate:40,sourceFrames:0,
    wrongRunIds:0,aliasCount:0,changedBlocks:0,checksumFailures:0,error:null,
    records:Array.from({length:40},(_,sequence)=>({runId:id,sequence,callbackCount:sequence+1,instanceId:id+':processor-0',
      frame:sequence*4,frameAfterCopy:sequence*4,frameAtExit:sequence*4,quantum:4,sampleRate:40,
      outputChannels:1,outputLengths:[4],inputChannels:1,inputLengths:[4],mainContextState:'running',
      previousTransferBytes:sequence?0:null,pcm:[0,0,0,0]})),
    window:{startFrame:133,sourceStartFrame:136,endFrame:160,scheduledAtFrame:128},
    markers:[{kind:'ready',runId:id,sequence:31,endFrame:128,required:32,streak:32,sampleRate:40,mainContextState:'running'},
      {kind:'armed',runId:id,frame:132,tooLate:false},{kind:'end',runId:id,blocks:40,frame:156,quantum:4,endFrame:160}]};
}
test('retains baseline contract and observed callback identities',()=>{
 const r=analyzeIsolation(fixture());assert.equal(r.integrity,true);assert.equal(r.baselineContractPass,true);
});
test('distinguishes fresh-callback duplicate frame from duplicate message',()=>{
 const r=fixture();r.records[35].frame=136;r.records[35].frameAfterCopy=136;r.records[35].frameAtExit=136;
 const m=analyzeIsolation(r);assert.equal(m.sequenceErrors,0);assert.equal(m.identityErrors,0);
 assert.equal(m.postReadyContinuous,false);assert.equal(m.integrity,false);assert.equal(m.anomalies.length,2);
});
test('deliberate immediate geometry does not convert baseline contract failure into a pass',()=>{
 const r=fixture();r.mode='immediate';r.window.sourceStartFrame=r.window.startFrame;
 const m=analyzeIsolation(r);assert.equal(m.integrity,true);assert.equal(m.baselineContractPass,false);
});
test('stale instance and failed buffer transfer fail integrity',()=>{
 const r=fixture();r.records[34].instanceId='other-context';r.records[34].previousTransferBytes=16;
 const m=analyzeIsolation(r);assert.equal(m.identityErrors,1);assert.equal(m.ownershipErrors,1);assert.equal(m.integrity,false);
});
