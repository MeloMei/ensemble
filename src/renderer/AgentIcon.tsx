import { TerminalSquare } from 'lucide-react';
import { useAppearance } from './appearance';
import codexLightLogo from './assets/providers/codex-light.png';
import codexDarkLogo from './assets/providers/codex-dark.png';
import claudeLogo from './assets/providers/claude.svg';

export function AgentIcon({ providerId, size = 16 }: { providerId: string; size?: number }) {
  const { theme } = useAppearance();
  const logo = providerId === 'codex' ? (theme === 'dark' ? codexDarkLogo : codexLightLogo) : providerId === 'claude' ? claudeLogo : undefined;
  const iconSize = providerId === 'codex' ? size + 4 : size;
  return logo ? <img className="agent-icon" src={logo} width={iconSize} height={iconSize} alt="" /> : <TerminalSquare size={size} />;
}
