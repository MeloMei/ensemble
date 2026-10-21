import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MotionConfig } from 'framer-motion';
import { AppearanceProvider, initializeAppearance } from './appearance';
import { OverlayProvider } from './ui';
import './vendor/open-claude-ui/cds-foundations.css';
import './styles.css';

initializeAppearance();
createRoot(document.getElementById('root')!).render(
  <React.StrictMode><AppearanceProvider><OverlayProvider><MotionConfig reducedMotion="user"><App /></MotionConfig></OverlayProvider></AppearanceProvider></React.StrictMode>,
);
