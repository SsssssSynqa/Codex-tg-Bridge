// Secret redaction for any text that leaves this machine (Telegram messages,
// approval cards, process logs).
//
// This lives in its own module so the smoke tests can import it directly:
// bridge.mjs is an entry point, and importing it would start the Telegram poll
// loop as a side effect.
//
// Covered secret shapes:
//   Telegram bot token (including the URL-embedded bot<id>:<token> form)
//   OpenAI / Anthropic API keys (sk- / sk-proj- / sk-ant-)
//   GitHub tokens (ghp_ / gho_ / ghu_ / ghs_ / ghr_ / github_pat_)
//   AWS access keys (AKIA...)
//   Google API keys, OpenRouter keys, Slack tokens, JWTs
//   HTTP Bearer tokens, PEM private keys, credentials embedded in URLs
//   Generic key=value / api_key: "xxx" pairs (covers .env files, curl -H, ...)

export function redactSensitiveText(value) {
  return String(value || '')
    .replace(/(?:bot)?\d+:[A-Za-z0-9_-]{30,}/g, '[telegram-token-redacted]')
    .replace(/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, '[openai-anthropic-key-redacted]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '[github-token-redacted]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[github-pat-redacted]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[aws-access-key-redacted]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[google-api-key-redacted]')
    .replace(/\bsk-or-v1-[A-Za-z0-9_-]{30,}\b/g, '[openrouter-key-redacted]')
    .replace(/\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{20,}\b/g, '[slack-token-redacted]')
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{8,})\.(?:eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}\b/g, '[jwt-redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._\-+/=]{20,}/gi, 'Bearer [token-redacted]')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
      '[private-key-redacted]')
    .replace(/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1[credentials-redacted]@')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password)=)[^&#\s]+/gi,
      '$1[secret-redacted]')
    // Generic key=value / api_key: "xxx".
    // Split into double-quoted / single-quoted / unquoted branches on purpose.
    // A backreference form like (['"])([^'"]*)\2 rejects any embedded quote and
    // therefore leaks `password='correct "horse" battery staple'`. With separate
    // branches, the double-quoted case only forbids double quotes and the
    // single-quoted case only forbids single quotes.
    .replace(/(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|token)\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|([^\s'"]+))/gi,
      (_m, prefix, dq, sq, _unq) => {
        if (dq !== undefined) return `${prefix}"[secret-redacted]"`;
        if (sq !== undefined) return `${prefix}'[secret-redacted]'`;
        return `${prefix}[secret-redacted]`;
      });
}
