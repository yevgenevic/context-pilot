// These are recognizable credential formats, not a general classifier for private text.
const hidden = '[скрыто]';
const privateKey = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|(?![\s\S]))/g;
const serviceToken = /\b(?:github_pat_[\w]{18,}|gh[pousr]_[a-z\d]{18,}|sk-[\w-]{18,}|xox[baprs]-[\w-]{12,}|npm_[a-z\d]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/gi;
const header = /\b(Bearer|(?:Proxy-)?Authorization[\"']?[ \t]*:[ \t]*[\"']?Basic)([ \t]+)[a-z\d+/._~=-]{8,}/gi;
const uriCredentials = /(\b[a-z][a-z\d+.-]{0,32}:\/\/)[^\s\/?#"'<>@]+@/gi;
const assignment = /(\b(?:[\w-]{1,48}[_-])?(?:password|passwd|api[_-]?key|(?:access|refresh|auth)[_-]?token|token|client[_-]?secret|secret(?:[_-]?(?:key|access[_-]?key))?)["']?[ \t]*[:=][ \t]*|--(?:password|passwd|token|api[_-]?key|client[_-]?secret)[ \t]+)(\[скрыто\]|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|[^\s,;\x22\x27\x60&|)\]}]+)/gi;

export function redactSecrets(text: string): string {
  return text.replace(privateKey, hidden)
    .replace(serviceToken, hidden)
    .replace(header, (_match, scheme, space) => scheme + space + hidden)
    .replace(uriCredentials, (_match, scheme) => scheme + hidden + '@')
    .replace(assignment, (_match, prefix: string, literal: string) => {
      const quote = literal.startsWith('"') || literal.startsWith("'") ? literal[0] : '';
      const value = quote ? literal.slice(1, -1) : literal;
      if (/^\$(?:\w+|\{\w+\})$/.test(value)) return prefix + literal;
      return prefix + quote + hidden + quote;
    });
}

export function redactJsonString(_key: string, value: unknown): unknown {
  return typeof value === 'string' ? redactSecrets(value) : value;
}
