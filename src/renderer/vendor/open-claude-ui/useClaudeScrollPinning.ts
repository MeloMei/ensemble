// Source: Caho1/open-claude-ui@4045ce76afdcb7dccef1b7e6417b04c4c6046e9c (MIT).
// Copyright (c) 2026 Caho1. License: licenses/Open-Claude-UI-MIT.txt.
// Adapted dependency typing, input cooldown scheduling, programmatic scroll ownership, and virtualized end scrolling.

import { useEffect, useRef, useState, useCallback } from 'react';

const BOTTOM_TOLERANCE = 40;
const JUMP_CONTROL_DISTANCE = 120;
const USER_INPUT_COOLDOWN = 150;

export function useClaudeScrollPinning(dependencies: readonly unknown[], scrollToEnd?: (smooth: boolean) => void) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPinned, setIsPinned] = useState(true);
  const [showJumpControl, setShowJumpControl] = useState(false);
  const pinned = useRef(true);
  const lastUserInputAt = useRef(Number.NEGATIVE_INFINITY);
  const programmaticScroll = useRef(false);
  const navigationOwnsScroll = useRef(false);
  const followTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scrollToEndRef = useRef(scrollToEnd);
  scrollToEndRef.current = scrollToEnd;

  const updatePinned = useCallback((value: boolean) => {
    const next = value && !navigationOwnsScroll.current;
    pinned.current = next;
    setIsPinned(next);
  }, []);

  const markUserInput = useCallback(() => {
    navigationOwnsScroll.current = false;
    programmaticScroll.current = false;
    lastUserInputAt.current = performance.now();
  }, []);

  const pauseForNavigation = useCallback(() => {
    clearTimeout(followTimer.current);
    navigationOwnsScroll.current = true;
    programmaticScroll.current = false;
    updatePinned(false);
  }, [updatePinned]);

  const handleScroll = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (programmaticScroll.current && distance > BOTTOM_TOLERANCE) return;
    programmaticScroll.current = false;
    updatePinned(distance <= BOTTOM_TOLERANCE);
    setShowJumpControl(distance > JUMP_CONTROL_DISTANCE);
  }, [updatePinned]);

  const scrollToBottom = useCallback((smooth = false) => {
    const element = containerRef.current;
    if (!element) return;
    clearTimeout(followTimer.current);
    navigationOwnsScroll.current = false;
    programmaticScroll.current = Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop) > 1;
    updatePinned(true);
    setShowJumpControl(false);
    if (scrollToEndRef.current) scrollToEndRef.current(smooth);
    else element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }, [updatePinned]);

  const followOutput = useCallback(function followOutput() {
    const element = containerRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setShowJumpControl(!pinned.current && distance > JUMP_CONTROL_DISTANCE);
    if (!pinned.current) return;
    const remaining = USER_INPUT_COOLDOWN - (performance.now() - lastUserInputAt.current);
    if (remaining > 0) {
      // A boundary wheel or nested scroll may never produce an outer scroll event.
      followTimer.current = setTimeout(followOutput, remaining);
      return;
    }
    scrollToBottom();
  }, [scrollToBottom]);

  useEffect(() => {
    followOutput();
    return () => clearTimeout(followTimer.current);
  }, dependencies);

  return { containerRef, isPinned, showJumpControl, markUserInput, pauseForNavigation, handleScroll, scrollToBottom };
}
