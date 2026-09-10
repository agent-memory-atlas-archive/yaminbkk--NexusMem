/**
 * Best-effort secret redaction for collected text before it is ever written
 * to the FTS index.
 *
 * This is a safety net, not a guarantee -- pattern-based redaction cannot
 * catch every shape a secret can take. It exists because conversation text
 * is the collector most likely to contain something sensitive (a pasted
 * credential, a key a user asked for help debugging), but a committed `.env`
 * or a hard-coded key makes the code-diff collector a real second candidate,
 * which is what the `high-confidence` profile below is for.
 */

interface Rule {
  name: string;
  pattern: RegExp;
  /**
   * The match is a secret by its own shape, with no reliance on the
   * surrounding text. Only these rules are safe to run over source code:
   * the shape rules match strings nothing else produces, while the
   * key/value rule matches ordinary code such as
   * `const apiKey = process.env.API_KEY` and would corrupt the very lines
   * a diff is indexed for.
   */
  highConfidence: boolean;
}

// The keyword may sit anywhere inside an identifier (DB_PASSWORD, OPENAI_API_KEY, dbPassword, --api-key).
// `token` is singular only: plural keys (max_tokens, rawTokens) are LLM token counts, not credentials.
const SECRET_KEYWORD = String.raw`(?:(?:pass(?:word|wd|phrase)|secret|credential|api[_-]?key|(?:access|private|secret|client|signing|encryption|master)[_-]?key)s?|token)`;
// Bare `pass` needs a prefix component or dashes (DB_PASS, --pass), so prose like "first pass: x" and `bypass` never match.
// Bounded so a long identifier run full of keywords stays linear, not quadratic.
const SECRET_KEY = String.raw`(?:[A-Za-z0-9_.-]{0,100}?${SECRET_KEYWORD}|(?:-{1,2}|(?:[A-Za-z0-9]{1,40}[_.-]){1,8})pass)(?:[_.-][A-Za-z0-9]{1,40}){0,8}`;
// Type annotations (`password: string`) are not values; everything else is hidden, however short.
const TYPE_WORD = String.raw`(?:string|number|boolean|bool|int|str|null|undefined|none|nil|true|false|any|unknown|object)(?=[\s;,)|\]}>]|$)`;
const SECRET_VALUE = String.raw`(?:"[^"\r\n]+"|'[^'\r\n]+'|\x60[^\x60\r\n]+\x60|[^\s'"\x60]+)`;

const RULES: Rule[] = [
  {
    name: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    highConfidence: true,
  },
  { name: 'aws-access-key', pattern: /\bAKIA[0-9A-Z]{16}\b/g, highConfidence: true },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, highConfidence: true },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, highConfidence: true },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    highConfidence: true,
  },
  // key/token/secret/password = "value" or : value, in code, JSON, env-file, shell or prose form.
  // The key start is an explicit non-identifier lookbehind, not `\b`: `_` is a word character, so
  // `\b` never fired inside DB_PASSWORD and the value leaked. Found live via `scan-shell`.
  {
    name: 'key-value-secret',
    pattern: new RegExp(
      String.raw`(?<![A-Za-z0-9_.-])(${SECRET_KEY})["']?[ \t]*[:=](?![=>])[ \t]*(?!${TYPE_WORD})(?!\[redacted\])${SECRET_VALUE}`,
      'gi',
    ),
    highConfidence: false,
  },
];

export interface RedactResult {
  text: string;
  redactedCount: number;
}

/**
 * `all` runs every rule -- the right trade for prose, where a false positive
 * costs a mangled sentence. `high-confidence` runs only the shape rules, for
 * text that *is* code and must survive redaction intact.
 */
export type RedactProfile = 'all' | 'high-confidence';

export function redact(text: string, profile: RedactProfile = 'all'): RedactResult {
  let redactedCount = 0;
  let out = text;

  for (const rule of RULES) {
    if (profile === 'high-confidence' && !rule.highConfidence) continue;
    out = out.replace(rule.pattern, (_match: string, ...rest: unknown[]) => {
      redactedCount += 1;
      // `String.replace` passes (match, ...groups, offset, wholeString), so for
      // a rule with no capture group `rest[0]` is the *offset* -- a number, and
      // truthy at any position but the very first. Testing the type rather than
      // truthiness is what keeps a match position out of the indexed corpus.
      const key = typeof rest[0] === 'string' ? rest[0] : null;
      // Keep the key name for key/value matches so the redaction is legible
      // ("apiKey: [redacted]" reads better than a bare "[redacted]").
      return key ? `${key}: [redacted]` : '[redacted]';
    });
  }

  return { text: out, redactedCount };
}
