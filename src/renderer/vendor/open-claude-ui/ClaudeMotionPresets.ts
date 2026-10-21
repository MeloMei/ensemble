// Selected from Caho1/open-claude-ui@4045ce76afdcb7dccef1b7e6417b04c4c6046e9c.
// Copyright (c) 2026 Caho1. MIT: licenses/Open-Claude-UI-MIT.txt.
// Tuned for Ensemble's compact controls and short, non-bouncing transitions.
import type { Transition, Variants } from 'framer-motion';

export const SPRING_SNAPPY: Transition = {
  type: 'spring', duration: 0.18, bounce: 0,
};

export const motionMessageFadeUp: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0, transition: SPRING_SNAPPY },
  exit: { opacity: 0, y: -2, transition: { duration: 0.1, ease: 'easeOut' } },
};

export const motionPopover: Variants = {
  initial: { opacity: 0, scale: 0.99, y: 3 },
  animate: { opacity: 1, scale: 1, y: 0, transition: SPRING_SNAPPY },
  exit: { opacity: 0, scale: 0.99, y: 2, transition: { duration: 0.1, ease: 'easeOut' } },
};
