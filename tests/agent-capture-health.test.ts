import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactAgentEvent } from '../src/agent/event.js';
import { HEALTHY_WINDOW_MS, readCaptureStatus, recordCaptureDrop } from '../src/agent/capture-health.js';

/**
 * Capture health has to separate "quiet because nobody was coding" from
 * "quiet because the payload shape changed and every event is being dropped".
 * Installed configuration proves neither.
 */

const NOW = new Date('2026-09-12T12:00:00.000Z');
const SECRET = 'health-s3cret-VALUE';

let dir: string;
let logPath: string;
let dropPath: string;

const paths = () => ({ logPath, dropStatePath: dropPath, now: NOW });

function writeEvent(minutesAgo: number, over: Record<string, unknown> = {}): void {
  const event = redactAgentEvent({
    agent: 'claude-code',
    sessionId: 's1',
    eventId: `e-${minutesAgo}`,
    ts: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
    cwd: 'D:/repo',
    kind: 'command',
    command: `psql postgres://app:${SECRET}@db/app`,
    outcome: 'fail',
    exitCode: 1,
    durationMs: 5,
    ...over,
  });
  writeFileSync(logPath, `${JSON.stringify(event)}\n`, { flag: 'a' });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nexusmem-health-'));
  logPath = join(dir, 'agent-events.jsonl');
  dropPath = join(dir, 'agent-capture-drops.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readCaptureStatus', () => {
  it('reports healthy from a recent event, naming its kind but never its content', () => {
    writeEvent(10);

    const status = readCaptureStatus(paths());

    expect(status).toMatchObject({ health: 'healthy', lastEventKind: 'command', lastEventOutcome: 'fail', drops: 0 });
    expect(status.lastEventAt).toBe(new Date(NOW.getTime() - 10 * 60_000).toISOString());
    expect(JSON.stringify(status)).not.toContain(SECRET);
    expect(JSON.stringify(status)).not.toContain('psql');
  });

  it('reports never-observed when the hook has never written anything', () => {
    expect(readCaptureStatus(paths())).toMatchObject({ health: 'never-observed', lastEventAt: null, drops: 0 });
  });

  it('reports stale once the last event falls outside the healthy window', () => {
    writeEvent(HEALTHY_WINDOW_MS / 60_000 + 60);

    expect(readCaptureStatus(paths()).health).toBe('stale');
  });

  it('reports failing when events are being dropped and none has ever been captured', () => {
    recordCaptureDrop('unsupported-event', dropPath, new Date(NOW.getTime() - 60_000));

    expect(readCaptureStatus(paths())).toMatchObject({
      health: 'failing',
      lastEventAt: null,
      lastDropReason: 'unsupported-event',
      drops: 1,
    });
  });

  it('reports failing when capture worked before but has been dropping since', () => {
    writeEvent(30);
    recordCaptureDrop('missing-fields', dropPath, new Date(NOW.getTime() - 60_000));

    const status = readCaptureStatus(paths());
    expect(status.health).toBe('failing');
    // The last success is still reported: that is what tells you when it broke.
    expect(status.lastEventAt).not.toBeNull();
  });

  it('stays healthy when the last drop predates the last successful capture', () => {
    recordCaptureDrop('unsupported-tool', dropPath, new Date(NOW.getTime() - 120 * 60_000));
    writeEvent(10);

    expect(readCaptureStatus(paths()).health).toBe('healthy');
  });

  it('counts repeated drops', () => {
    recordCaptureDrop('unparsable-json', dropPath, NOW);
    recordCaptureDrop('unparsable-json', dropPath, NOW);

    expect(readCaptureStatus(paths()).drops).toBe(2);
  });

  it('treats a corrupt drop-state file as no evidence rather than failing', () => {
    writeFileSync(dropPath, '{ not json');
    writeEvent(10);

    expect(readCaptureStatus(paths())).toMatchObject({ health: 'healthy', lastDropReason: null, drops: 0 });
  });

  it('ignores a drop reason that is not one of the known codes', () => {
    writeFileSync(dropPath, JSON.stringify({ lastDropAt: NOW.toISOString(), lastDropReason: `leaked ${SECRET}`, drops: 1 }));

    const status = readCaptureStatus(paths());
    expect(status.lastDropReason).toBeNull();
    expect(JSON.stringify(status)).not.toContain(SECRET);
  });

  it('never writes anything but a known code, even when handed something else', () => {
    recordCaptureDrop(`unparsable-json ${SECRET}` as never, dropPath, NOW);

    expect(readCaptureStatus(paths()).lastDropReason).toBe('missing-fields');
    expect(readFileSync(dropPath, 'utf8')).not.toContain(SECRET);
  });

  it('reports unknown when the log exists but nothing in it can be parsed', () => {
    writeFileSync(logPath, 'garbage\nmore garbage\n');

    expect(readCaptureStatus(paths()).health).toBe('unknown');
  });

  it('skips a torn final line and reports the last line that does parse', () => {
    writeEvent(10);
    writeFileSync(logPath, '{"agent":"claude-code","sessi', { flag: 'a' });

    expect(readCaptureStatus(paths())).toMatchObject({ health: 'healthy', lastEventKind: 'command' });
  });
});
