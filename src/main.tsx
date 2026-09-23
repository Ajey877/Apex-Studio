import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import './uiAudit.css';
import {audioEngine} from './audio/audioEngine';
import {installLiveFxChainHardening} from './audio/liveFxChainHardening';
import {installSampleBufferPersistence} from './audio/sampleBufferPersistence';
import {AppErrorBoundary} from './components/AppErrorBoundary';

installLiveFxChainHardening(audioEngine);
// Dropped and bounced playlist audio is registered through setSampleBuffer; persist it so it survives reloads.
installSampleBufferPersistence(audioEngine);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
