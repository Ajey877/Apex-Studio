import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LimiterEffect } from './effects/LimiterEffect';
import { PhaserEffect } from './effects/PhaserEffect';

type Param = { value:number; calls:Array<[number,number]>; setValueAtTime(value:number,time:number):void };
type Node = { connections:unknown[]; connect(target:unknown):void; disconnect():void };
const param=(value=0):Param=>({value,calls:[],setValueAtTime(v,t){this.value=v;this.calls.push([v,t]);}});
const node=():Node=>({connections:[],connect(t){this.connections.push(t);},disconnect(){this.connections.length=0;}});
function context():AudioContext {
 const gain=()=>({...node(),gain:param(1)});
 const biquad=()=>({...node(),frequency:param(),type:'allpass'});
 const osc=()=>({...node(),frequency:param(),start(){},stop(){}});
 const compressor=()=>({...node(),threshold:param(),knee:param(),ratio:param(),attack:param(),release:param()});
 return {currentTime:10,createGain:gain,createBiquadFilter:biquad,createOscillator:osc,createDynamicsCompressor:compressor} as unknown as AudioContext;
}

describe('Phase 5 phaser and limiter effects',()=>{
 it('constructs phaser, schedules parameters, validates bounds and disposes safely',()=>{
  const e=new PhaserEffect(context());
  assert.equal(e.name,'Phaser');
  assert.doesNotThrow(()=>e.setParameter('rate',2,20));
  assert.doesNotThrow(()=>e.setParameter('depth',1200,20));
  assert.throws(()=>e.setParameter('feedback',1,20),/between 0 and 0.95/);
  assert.throws(()=>e.setParameter('center',70,20),/between 80 and 8000/);
  assert.throws(()=>e.setParameter('mix',Number.NaN,20),/must be finite/);
  e.dispose(); assert.doesNotThrow(()=>e.dispose()); assert.throws(()=>e.setParameter('mix',0.5,20),/disposed/);
 });
 it('constructs limiter with safety defaults and automates its controls',()=>{
  const e=new LimiterEffect(context());
  assert.equal(e.name,'Limiter');
  assert.doesNotThrow(()=>e.setParameter('ceiling',-1,20));
  assert.doesNotThrow(()=>e.setParameter('release',0.2,20));
  assert.doesNotThrow(()=>e.setParameter('drive',6,20));
  assert.throws(()=>e.setParameter('ceiling',1,20),/between -12 and 0/);
  assert.throws(()=>e.setParameter('release',0,20),/between 0.01 and 1/);
  assert.throws(()=>e.setParameter('mix',1.1,20),/between 0 and 1/);
  e.dispose(); assert.doesNotThrow(()=>e.dispose());
 });
});
