import test from 'node:test';
import assert from 'node:assert/strict';
import { audioEngine } from './audioEngine';
import { getAudioIdsForProject, reconcilePersistedAudio, serializeProjectState } from '../state/projectPersistence';
import { createDefaultProjectState } from '../state/projectState';
import type { ProjectState } from '../types/daw';

const buffer = { duration: 1 } as AudioBuffer;

const cleanup = (...ids: string[]) => {
  audioEngine.setProjectSampleBufferOwnership(ids);
  audioEngine.setProjectSampleBufferOwnership([]);
};

test('Phase 33: A -> B releases outgoing project-owned buffer while preserving B', () => {
  const a = 'phase33-project-a';
  const b = 'phase33-project-b';
  audioEngine.setSampleBuffer(a, buffer);
  audioEngine.setProjectSampleBufferOwnership([a]);
  assert.ok(audioEngine.getSampleBuffer(a));

  audioEngine.setSampleBuffer(b, buffer);
  audioEngine.setProjectSampleBufferOwnership([b]);

  assert.equal(audioEngine.getSampleBuffer(a), undefined);
  assert.equal(audioEngine.getSampleBuffer(b), buffer);
  assert.deepEqual(audioEngine.getProjectOwnedSampleBufferIds(), [b]);
  cleanup(b);
});

test('Phase 33: explicit session-only buffer survives project replacement', () => {
  const a = 'phase33-session-a';
  const session = 'phase33-session-only';
  const b = 'phase33-session-b';

  audioEngine.setSampleBuffer(a, buffer);
  audioEngine.setProjectSampleBufferOwnership([a]);
  audioEngine.setSampleBuffer(session, buffer);
  audioEngine.setSampleBuffer(b, buffer);

  audioEngine.setProjectSampleBufferOwnership([b]);

  assert.equal(audioEngine.getSampleBuffer(a), undefined);
  assert.equal(audioEngine.getSampleBuffer(b), buffer);
  assert.equal(audioEngine.getSampleBuffer(session), buffer);
  assert.ok(audioEngine.getSessionSampleBufferIds().includes(session));
  cleanup(b, session);
});

test('Phase 33: persistence reconciliation excludes outgoing project audio but keeps incoming and session audio', async () => {
  const state = createDefaultProjectState();
  const incomingId = 'phase33-incoming-persisted';
  const outgoingId = 'phase33-outgoing-persisted';
  const sessionId = 'phase33-session-persisted';

  const persisted = new Set([incomingId, outgoingId, sessionId]);
  const result = await reconcilePersistedAudio(
    { ...state, playlistClips: [{
      id: 'phase33-b',
      trackIndex: 1,
      startBar: 0,
      lengthBars: 1,
      type: 'audio',
      audioBufferId: incomingId,
      color: '#fff',
      name: 'B'
    }] },
    {
      additionalReferencedIds: [sessionId],
      storage: {
        listPersistedAudioClipIds: async () => [...persisted],
        deletePersistedAudioClip: async id => { persisted.delete(id); },
        listProjectBackupRecords: async () => []
      }
    }
  );

  assert.ok(result.preservedIds.includes(incomingId));
  assert.ok(result.preservedIds.includes(sessionId));
  assert.deepEqual(result.removedIds, [outgoingId]);
  assert.equal(persisted.has(outgoingId), false);
});

test('Phase 33: repeated A -> B -> C -> D replacement does not accumulate project-owned buffers', () => {
  const ids = ['phase33-a', 'phase33-b', 'phase33-c', 'phase33-d'];

  for (const id of ids) {
    audioEngine.setSampleBuffer(id, buffer);
    audioEngine.setProjectSampleBufferOwnership([id]);
    assert.deepEqual(audioEngine.getProjectOwnedSampleBufferIds(), [id]);
    assert.deepEqual(audioEngine.getProjectOwnedSampleBufferIds().filter(value => value.startsWith('phase33-')), [id]);
  }

  assert.equal(audioEngine.getSampleBuffer(ids[0]), undefined);
  assert.equal(audioEngine.getSampleBuffer(ids[1]), undefined);
  assert.equal(audioEngine.getSampleBuffer(ids[2]), undefined);
  assert.equal(audioEngine.getSampleBuffer(ids[3]), buffer);
  cleanup(ids[3]);
});

test('Phase 33: save/reload project audio references converge on incoming project assets', () => {
  const stateA = createDefaultProjectState();
  const stateB: ProjectState = {
    ...stateA,
    meta: { ...stateA.meta, name: 'Project B' },
    playlistClips: [{
      id: 'phase33-reload-b',
      trackIndex: 1,
      startBar: 0,
      lengthBars: 2,
      type: 'audio',
      audioBufferId: 'phase33-reload-b-audio',
      color: '#fff',
      name: 'B Audio'
    }]
  };

  const serialized = serializeProjectState(stateB);
  const restored = JSON.parse(serialized).state as ProjectState;
  assert.deepEqual(getAudioIdsForProject(restored), ['phase33-reload-b-audio']);
  assert.deepEqual(getAudioIdsForProject(stateA), []);
});
