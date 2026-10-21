export function buildCodexLink(input: { cwd: string; prompt: string }): string {
  const url = new URL('codex://threads/new');
  url.searchParams.set('path', input.cwd);
  if (input.prompt) url.searchParams.set('prompt', input.prompt);
  return url.toString();
}
