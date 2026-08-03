import path from 'node:path';

export function commandText(command) {
  return Array.isArray(command) ? command.join(' ') : String(command || '');
}

export function normalizeAllowedRoots(roots, fallbackRoot) {
  const values = Array.isArray(roots) && roots.length ? roots : [fallbackRoot];
  return [...new Set(values.map((root) => path.resolve(root)))];
}

export function isPathWithinRoots(filePath, roots, cwd) {
  if (!filePath) return true;
  const resolved = path.resolve(path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath));
  return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
}

export function extractWriteTargets(command) {
  const text = commandText(command);
  const targets = [];
  for (const match of text.matchAll(/(?:^|[\s;&|])>{1,2}\s*([^\s;&|<>]+)/g)) targets.push(match[1]);
  for (const match of text.matchAll(/\b(?:cp|mv|install|rsync)\s+([^;&|]+)/gi)) {
    const tokens = match[1].trim().split(/\s+/).filter((token) => !token.startsWith('-'));
    if (tokens.length >= 2) targets.push(tokens.at(-1));
  }
  for (const match of text.matchAll(/\btee\s+(?:-[a-zA-Z]*\s+)*([^\s;&|]+)/gi)) targets.push(match[1]);
  for (const match of text.matchAll(/\bof=([^\s;&|]+)/gi)) targets.push(match[1]);
  for (const match of text.matchAll(/\b(?:curl|wget)\b[^;&|]*\s(?:-o|--output|-O)\s*([^\s;&|]+)/gi)) targets.push(match[1]);
  return targets
    .map((target) => target.replace(/^['"]|['"]$/g, ''))
    .filter((target) => target && target !== '/dev/null' && target !== '&1' && target !== '&2');
}

export function isDangerousCommand(command) {
  const text = commandText(command);
  return [
    /(?:^|[;&|]\s*|\s)(?:\/[^\s]+\/)?rm\b/i,
    /\b(?:unlink|rmdir|shred)\b/i,
    /\btruncate\s+-s\s+0\b/i,
    /\bsudo\b/i,
    /\bgit\s+(?:reset\s+--hard|restore\b|clean\b[^;&|]*(?:-[a-zA-Z]*[fx]|--force)|checkout\s+(?:--\s*)?(?:\.|\/|[^-\s]))/i,
    /\bgit\s+push\b[^;&|]*(?:--force-with-lease|--force|\s-f\b)/i,
    /\b(?:chmod|chown)\b/i,
    /\bdd\s+[^;&|]*(?:if=|of=)/i,
    /\b(?:diskutil|mkfs|fdisk|parted)\b/i,
    /\blaunchctl\s+(?:bootout|remove|unload|kickstart|stop|disable|kill)\b/i,
    /\b(?:killall|pkill)\b/i,
    /(?:^|\s|\/)kill\s+(?:-|\d)/i,
    /\|\s*(?:sh|bash|zsh|fish|ksh|tcsh|dash)\b/i,
    /\b(?:node|python|python3|ruby|perl)\s+-[ec]\b/i,
    /\bfind\s+[^;&|]*(?:-delete|-exec|-execdir)\b/i,
    /\bxargs\s+[^;&|]*\brm\b/i,
    />\s*\/dev\/(?:sd[a-z]|disk\d|rdisk\d)/i,
    /\b(?:env|printenv|set)\s*(?:$|[;&|])/i,
    /\b\d+:[A-Za-z0-9_-]{30,}\b/,
  ].some((pattern) => pattern.test(text));
}

// Only simple, side-effect-free inspection commands may be approved silently.
// Shell composition, substitutions, redirects and arbitrary interpreters always
// require an explicit owner decision even when the cwd is inside writable roots.
export function isSafeInspectionCommand(command) {
  const text = commandText(command).trim();
  if (!text || /[;&|><`]|\$\(|\n|\r/.test(text)) return false;
  const tokens = text.split(/\s+/);
  const executable = path.basename(tokens[0]);
  if (executable === 'git') {
    return /^(?:status|diff|log|show|rev-parse|branch|remote|tag|ls-files|ls-tree)$/.test(tokens[1] || '');
  }
  if (executable === 'sed' && !tokens.includes('-n')) return false;
  if (executable === 'find' && tokens.some((token) => /^-(?:delete|exec|execdir|ok|okdir)$/.test(token))) return false;
  return new Set([
    'pwd', 'ls', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'egrep', 'fgrep',
    'sed', 'find', 'stat', 'file', 'du', 'df', 'which', 'whereis', 'realpath',
    'basename', 'dirname', 'date', 'id', 'whoami', 'uname', 'ps', 'pgrep',
  ]).has(executable);
}
