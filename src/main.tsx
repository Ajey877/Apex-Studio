import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import './uiAudit.css';
import {audioEngine} from './audio/audioEngine';
import {installSampleBufferPersistence} from './audio/sampleBufferPersistence';
import {AppErrorBoundary} from './components/AppErrorBoundary';

// Dropped and bounced playlist audio is registered through setSampleBuffer; persist it so it survives reloads.
installSampleBufferPersistence(audioEngine);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);

// Do not expose a test API during ordinary desktop/browser sessions. The flag
// comes from main-process launch arguments, never a renderer-selected plugin.
const smokeWindow = globalThis as unknown as { desktopApp?: { smokeTest?: boolean }; __apexVst3Smoke?: Promise<unknown> };
if (smokeWindow.desktopApp?.smokeTest) {
  smokeWindow.__apexVst3Smoke = import('./audio/nativeVst3DesktopSmoke').then(module => module.runDesktopVst3Smoke());
  smokeWindow.__apexVst3Smoke.catch(() => {}); // main awaits and reports failures
}
