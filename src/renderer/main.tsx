import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MotionConfig } from 'framer-motion';
import { AppearanceProvider, initializeAppearance } from './appearance';
import { OverlayProvider } from './ui';
import { LanguageProvider } from './language';
import { initializeI18n, translate } from '../shared/i18n';
import { PRODUCT_NAME } from '../shared/app-identity';
import './vendor/open-claude-ui/cds-foundations.css';
import './styles.css';

initializeAppearance();
async function start() {
  const language = await window.workbench.getLanguage();
  await initializeI18n(language.language);
  document.documentElement.lang = language.language;
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode><LanguageProvider initial={language}><AppearanceProvider><OverlayProvider><MotionConfig reducedMotion="user"><App /></MotionConfig></OverlayProvider></AppearanceProvider></LanguageProvider></React.StrictMode>,
  );
}
void start().catch(error => {
  document.getElementById('root')!.textContent = `${translate('native:startup.failed', { product: PRODUCT_NAME })}: ${error instanceof Error ? error.message : String(error)}`;
});
