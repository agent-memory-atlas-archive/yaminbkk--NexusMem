import { describe, expect, it } from 'vitest';
import { redact } from '../src/conversation/redact.js';

/**
 * Security regression suite for the `key-value-secret` rule. Found live by a
 * user running `scan-shell` on real history: the rule's leading `\b` never
 * fires between `_` and a keyword, so `PASSWORD=x` redacted while
 * `DB_PASSWORD=x` printed the live value.
 */

const SECRET_KEYS = [
  'PASSWORD',
  'DB_PASSWORD',
  'MYSQL_PASSWORD',
  'PROD_PASSWORD',
  'DATABASE_PASSWORD',
  'PGPASSWORD',
  'API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'SECRET',
  'CLIENT_SECRET',
  'SECRET_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'TOKEN',
  'AUTH_TOKEN',
  'GITHUB_TOKEN',
  'DB_PASS',
  'DB_PASSWORD_PROD',
  'prod-api-key',
  'db_password',
  'openai_api_key',
  'Db_Password',
  'dbPassword',
  'spring.datasource.password',
];

describe('redact key-value-secret: prefixed key names', () => {
  it.each(SECRET_KEYS)('redacts %s=secret', (key) => {
    expect(redact(`${key}=secret`).text).toBe(`${key}: [redacted]`);
  });

  it.each(SECRET_KEYS)('redacts %s: secret', (key) => {
    expect(redact(`${key}: secret`).text).toBe(`${key}: [redacted]`);
  });
});

describe('redact key-value-secret: shell forms', () => {
  it.each([
    ['export DB_PASSWORD=secret', 'export DB_PASSWORD: [redacted]'],
    ['DB_PASSWORD="secret"', 'DB_PASSWORD: [redacted]'],
    ["DB_PASSWORD='secret'", 'DB_PASSWORD: [redacted]'],
    ['DB_PASSWORD = secret', 'DB_PASSWORD: [redacted]'],
    ['set DB_PASSWORD=secret', 'set DB_PASSWORD: [redacted]'],
    ['$env:DB_PASSWORD="secret"', '$env:DB_PASSWORD: [redacted]'],
    ["$env:DB_PASSWORD = 'secret'", '$env:DB_PASSWORD: [redacted]'],
    ['DB_PASSWORD=secret command', 'DB_PASSWORD: [redacted] command'],
    ['DB_USER=admin DB_PASSWORD=secret psql -h db', 'DB_USER=admin DB_PASSWORD: [redacted] psql -h db'],
    ['export PASSWORD=my-secret', 'export PASSWORD: [redacted]'],
    ['export DB_PASSWORD=my-secret', 'export DB_PASSWORD: [redacted]'],
    ['mytool --password=secret --verbose', 'mytool --password: [redacted] --verbose'],
    ['mytool --api-key=secret', 'mytool --api-key: [redacted]'],
    ['mytool --pass=secret', 'mytool --pass: [redacted]'],
  ])('%s', (input, expected) => {
    expect(redact(input).text).toBe(expected);
  });

  it('hides the whole value when it contains shell-special characters', () => {
    const result = redact('DB_PASSWORD=p@ss!w0rd#$%^&* psql');
    expect(result.text).toBe('DB_PASSWORD: [redacted] psql');
  });

  it('hides a quoted value that contains spaces', () => {
    expect(redact('DB_PASSWORD="correct horse battery staple" psql').text).toBe('DB_PASSWORD: [redacted] psql');
  });

  it('hides short values -- a real password is not guaranteed to be 8+ characters', () => {
    expect(redact('DB_PASSWORD=abc').text).toBe('DB_PASSWORD: [redacted]');
  });

  it('redacts a quoted JSON key', () => {
    const result = redact('{"db_password": "secret-value"}');
    expect(result.text).not.toContain('secret-value');
    expect(result.text).toContain('db_password: [redacted]');
  });

  it('counts each redacted assignment', () => {
    expect(redact('A_TOKEN=x B_PASSWORD=y').redactedCount).toBe(2);
  });
});

describe('redact key-value-secret: prose and code stay untouched', () => {
  it.each([
    'we chose BM25 because developer queries are keyword-heavy',
    'I forgot my password again and need a reset link',
    'the token expires after an hour',
    'Here is the secret:\nwe rotate keys weekly',
    'tokenizer=bert',
    'bypass=true',
    'sort_key=name primary_key=id monkey=banana',
    'PWD=/home/me',
    'password: string;',
    'token: string | null',
    'if (password === other) return',
    // Real false positives measured on this repo's own conversation corpus while fixing the leak.
    'first pass: collect every id',
    'max_tokens=4096',
    'USD_PER_MILLION_TOKENS = 0.25',
    'const rawTokens = text.split(" ")',
    'approxTokens: 1234',
  ])('%s', (text) => {
    expect(redact(text)).toEqual({ text, redactedCount: 0 });
  });
});
