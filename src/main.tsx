import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {audioEngine} from './audio/audioEngine';
import {installLiveFxChainHardening} from './audio/liveFxChainHardening';

installLiveFxChainHardening(audioEngine);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
