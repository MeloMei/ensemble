import { CopyTextButton, type CopyTextLabels } from './CopyTextButton';
import './CodeBlock.css';

export function CodeBlock({ text, language, copyLabels }: { text: string; language?: string; copyLabels: CopyTextLabels }) {
  return <div className="ui-code-block">
    <div className="ui-code-block-header">
      {language && <span className="ui-code-block-language">{language}</span>}
      <CopyTextButton text={text} labels={copyLabels} />
    </div>
    <pre><code className={language ? `language-${language}` : undefined}>{text}</code></pre>
  </div>;
}
