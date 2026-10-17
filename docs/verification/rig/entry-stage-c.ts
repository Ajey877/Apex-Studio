// Stage C read-only browser entry. The build helper substitutes the commit
// marker and redirects this source import into a temporary git-archive tree.
import { audioEngine } from '../../../src/audio/audioEngine';
import { START_LEAD_SECONDS } from '../../../src/audio/transport';

const target = window as unknown as Record<string, unknown>;
target.audioEngine = audioEngine;
target.__STAGE_C_SOURCE_COMMIT__ = '__SOURCE_COMMIT__';
target.__STAGE_C_START_LEAD_SECONDS__ = START_LEAD_SECONDS;
