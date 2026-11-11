import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FileImage } from '../shared/types';

const markdownPlugins = [remarkGfm];
const markdownComponents: Components = {
  img: ({ alt }) => alt ? <span>{alt}</span> : null,
  a: ({ href, children }) => href && /^https?:\/\//i.test(href)
    ? <button type="button" className="file-markdown-link" onClick={() => window.open(href, '_blank', 'noopener,noreferrer')}>{children}</button>
    : <span>{children}</span>,
};

export const MarkdownFilePreview = memo(function MarkdownFilePreview({ text }: { text: string }) {
  const { t } = useTranslation('workspace');
  return <div className="file-markdown-preview" role="region" aria-label={t('files.markdownPreview')} tabIndex={0}>
    <ReactMarkdown skipHtml remarkPlugins={markdownPlugins} components={markdownComponents}>{text}</ReactMarkdown>
  </div>;
});

export function ImageFilePreview({ image }: { image: FileImage }) {
  const { t } = useTranslation('workspace');
  const [failed, setFailed] = useState(false);
  return <div className="file-image-preview">
    {failed ? <p className="pane-note error-text" role="alert">{t('files.imageDecodeFailed')}</p>
      : <img alt={image.path} src={`data:${image.mimeType};base64,${image.base64}`} decoding="async" onError={() => setFailed(true)} />}
  </div>;
}
