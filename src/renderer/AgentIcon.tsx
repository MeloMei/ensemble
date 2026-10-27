import { TerminalSquare } from 'lucide-react';
import { useAppearance } from './appearance';
import codexLightLogo from './assets/providers/codex-light.png';
import codexDarkLogo from './assets/providers/codex-dark.png';
import claudeLogo from './assets/providers/claude.svg';
import openCodeLightLogo from './assets/providers/opencode-light.svg';
import openCodeDarkLogo from './assets/providers/opencode-dark.svg';
import deepSeekLightLogo from './assets/providers/deepseek-harness-light.svg';
import deepSeekDarkLogo from './assets/providers/deepseek-harness-dark.svg';
import piLightLogo from './assets/providers/pi-light.svg';
import piDarkLogo from './assets/providers/pi-dark.svg';
import geminiLogo from './assets/providers/gemini.png';
import cursorLightLogo from './assets/providers/cursor-light.svg';
import cursorDarkLogo from './assets/providers/cursor-dark.svg';
import qoderLightLogo from './assets/providers/qoder-light.png';
import qoderDarkLogo from './assets/providers/qoder-dark.png';

interface ProviderLogo { light: string; dark?: string; sizeOffset?: number }

const providerLogos: Readonly<Record<string, ProviderLogo | undefined>> = {
  codex: { light: codexLightLogo, dark: codexDarkLogo, sizeOffset: 4 },
  claude: { light: claudeLogo },
  opencode: { light: openCodeLightLogo, dark: openCodeDarkLogo },
  'deepseek-harness': { light: deepSeekLightLogo, dark: deepSeekDarkLogo },
  pi: { light: piLightLogo, dark: piDarkLogo },
  gemini: { light: geminiLogo },
  cursor: { light: cursorLightLogo, dark: cursorDarkLogo },
  qoder: { light: qoderLightLogo, dark: qoderDarkLogo },
};

export function AgentIcon({ providerId, size = 16 }: { providerId: string; size?: number }) {
  const { theme } = useAppearance();
  const logo = providerLogos[providerId];
  const source = theme === 'dark' ? logo?.dark ?? logo?.light : logo?.light;
  const iconSize = size + (logo?.sizeOffset ?? 0);
  return source ? <img className="agent-icon" src={source} width={iconSize} height={iconSize} alt="" /> : <TerminalSquare size={size} />;
}
