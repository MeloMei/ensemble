import type { WebContents } from 'electron';
import { z } from 'zod';
import { EVIDENCE_EXCERPT_LIMIT, localPreviewUrl, previewFrameName } from '../shared/draft-evidence';
import type { PreviewEvidenceSource } from '../shared/types';

const captureSchema = z.object({ selector: z.string().min(1).max(4096), excerpt: z.string().max(EVIDENCE_EXCERPT_LIMIT) }).strict();
export const previewPointSchema = z.object({ x: z.number().finite().min(0).max(16_384), y: z.number().finite().min(0).max(16_384) }).strict();
type PreviewPoint = z.infer<typeof previewPointSchema>;

function captureElement({ x, y }: PreviewPoint, excerptLimit: number) {
  const element = document.elementFromPoint(x, y);
  if (!element || element === document.body || element === document.documentElement || element instanceof HTMLIFrameElement) return null;
  const steps: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node.id) {
      const candidate = `#${CSS.escape(node.id)}`;
      if (document.querySelectorAll(candidate).length === 1) { steps.unshift(candidate); break; }
    }
    let sibling = node.previousElementSibling;
    let index = 1;
    while (sibling) {
      if (sibling.localName === node.localName) index++;
      sibling = sibling.previousElementSibling;
    }
    steps.unshift(`${CSS.escape(node.localName)}:nth-of-type(${index})`);
  }
  const selector = steps.join(' > ');
  const text = element instanceof HTMLElement ? element.innerText : element.textContent;
  const excerpt = (element.getAttribute('aria-label') || text || element.getAttribute('alt') || '').trim().slice(0, excerptLimit);
  return { selector, excerpt };
}

function paintAnnotations(annotations: PreviewEvidenceSource[], revealId: string | undefined) {
  if (!document.body) return false;
  const layerId = 'ensemble-preview-annotations';
  document.getElementById(layerId)?.dispatchEvent(new Event('ensemble-remove-annotations'));
  document.getElementById(layerId)?.remove();
  if (!annotations.length) return true;
  const layer = document.createElement('div');
  layer.id = layerId;
  Object.assign(layer.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '2147483647' });
  const shadow = layer.attachShadow({ mode: 'closed' });
  const find = (selector: string) => {
    try { return document.querySelector(selector); }
    catch { return null; }
  };
  const paint = () => {
    shadow.replaceChildren();
    for (const annotation of annotations) {
      if (annotation.url !== location.href) continue;
      const rect = find(annotation.selector)?.getBoundingClientRect();
      if (!rect?.width || !rect.height || rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth) continue;
      const marker = document.createElement('span');
      marker.textContent = `#${annotation.number}`;
      Object.assign(marker.style, {
        position: 'absolute', top: `${Math.max(0, rect.top)}px`, left: `${Math.max(0, rect.left)}px`,
        padding: '2px 6px', borderRadius: '10px', font: 'bold 12px system-ui', color: '#fff',
        backgroundColor: annotation.annotationId === revealId ? '#3d47bd' : '#6754cd', boxShadow: '0 0 0 2px white',
      });
      shadow.append(marker);
    }
  };
  let nextFrame = 0;
  const schedule = () => {
    cancelAnimationFrame(nextFrame);
    nextFrame = requestAnimationFrame(paint);
  };
  layer.addEventListener('ensemble-remove-annotations', () => {
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('popstate', schedule);
    observer.disconnect();
    cancelAnimationFrame(nextFrame);
  }, { once: true });
  document.documentElement.append(layer);
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  window.addEventListener('popstate', schedule);
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true });
  const reveal = annotations.find(item => item.annotationId === revealId && item.url === location.href);
  const target = reveal && find(reveal.selector);
  target?.scrollIntoView({ block: 'center' });
  paint();
  return !revealId || Boolean(target);
}

function previewFrame(contents: WebContents, tabId: string) {
  const frame = contents.mainFrame.frames.find(item => item.name === previewFrameName(tabId));
  if (!frame || frame.detached || frame.isDestroyed() || !localPreviewUrl(frame.url) || frame.origin === contents.mainFrame.origin) return undefined;
  return frame;
}

async function executePreviewScript(frame: NonNullable<ReturnType<typeof previewFrame>>, code: string): Promise<unknown> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([frame.executeJavaScript(code), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('本地预览没有响应。')), 3000);
    })]);
  } finally { clearTimeout(timeout); }
}

export async function capturePreviewElement(contents: WebContents, tabId: string, point: PreviewPoint) {
  const frame = previewFrame(contents, tabId);
  if (!frame) return null;
  const url = frame.url;
  const result = await executePreviewScript(frame, `(${captureElement})(${JSON.stringify(point)}, ${EVIDENCE_EXCERPT_LIMIT})`);
  if (!result || frame.isDestroyed() || frame.url !== url) return null;
  return { url, ...captureSchema.parse(result) };
}

export async function displayPreviewAnnotations(contents: WebContents, tabId: string, annotations: PreviewEvidenceSource[], revealId?: string) {
  const frame = previewFrame(contents, tabId);
  if (!frame) return 'unavailable' as const;
  const reveal = annotations.find(item => item.tabId === tabId && item.annotationId === revealId);
  if (reveal && reveal.url !== frame.url) return 'wrong-page' as const;
  const shown = annotations.filter(item => item.tabId === tabId && new URL(item.url).origin === frame.origin);
  const painted = await executePreviewScript(frame, `(${paintAnnotations})(${JSON.stringify(shown)}, ${JSON.stringify(revealId)})`);
  return painted === true ? 'shown' as const : 'missing-element' as const;
}
