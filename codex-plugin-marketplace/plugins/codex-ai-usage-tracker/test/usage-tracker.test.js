import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  aggregateEvents,
  appendEventOnce,
  appendEvent,
  defaultHookLogPath,
  eventFromCodexHookPayload,
  eventFromCodexTranscript,
  estimateCostUsd,
  findLatestCodexTranscript,
  formatReport,
  loadEvents,
  trackEvent
} from '../src/usage-tracker.js';

test('trackEvent normalizes token fields and computes total tokens', () => {
  const event = trackEvent({
    id: 'evt_1',
    timestamp: '2026-06-01T12:00:00Z',
    model: 'gpt-5',
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 30,
    reasoningTokens: 10
  });

  assert.equal(event.day, '2026-06-01');
  assert.equal(event.totalTokens, 160);
  assert.equal(event.source, 'codex-plugin');
});

test('appendEvent and loadEvents use JSONL storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-'));
  const log = join(dir, 'events.jsonl');

  try {
    await appendEvent(log, trackEvent({
      timestamp: '2026-06-01T12:00:00Z',
      model: 'gpt-5',
      inputTokens: 1,
      outputTokens: 2
    }));

    const raw = await readFile(log, 'utf8');
    const events = await loadEvents(log);

    assert.match(raw, /"model":"gpt-5"/);
    assert.equal(events.length, 1);
    assert.equal(events[0].totalTokens, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('appendEventOnce skips duplicate event ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-'));
  const log = join(dir, 'events.jsonl');

  try {
    const event = trackEvent({
      id: 'evt_duplicate',
      timestamp: '2026-06-01T12:00:00Z',
      model: 'gpt-5',
      inputTokens: 1,
      outputTokens: 2
    });

    assert.equal(await appendEventOnce(log, event), true);
    assert.equal(await appendEventOnce(log, event), false);
    assert.equal((await loadEvents(log)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('eventFromCodexHookPayload records direct hook usage when available', async () => {
  const event = await eventFromCodexHookPayload({
    hook_event_name: 'Stop',
    timestamp: '2026-06-01T12:00:00Z',
    cwd: 'C:\\Users\\Chill\\vsCode\\antichurn',
    model: 'gpt-5',
    session_id: 'session_1',
    turn_id: 'turn_1',
    usage: {
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 30,
      reasoning_output_tokens: 5
    }
  });

  assert.equal(event.source, 'codex-hook');
  assert.equal(event.project, 'antichurn');
  assert.equal(event.session, 'session_1');
  assert.equal(event.totalTokens, 155);
  assert.equal(event.metadata.usageSource, 'hook:usage');
});

test('eventFromCodexHookPayload falls back to transcript token_count events', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-'));
  const transcript = join(dir, 'rollout.jsonl');

  try {
    await writeFile(transcript, [
      JSON.stringify({
        timestamp: '2026-06-01T11:59:00.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5-codex' }
      }),
      JSON.stringify({
        timestamp: '2026-06-01T12:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 800,
              output_tokens: 100,
              reasoning_output_tokens: 50,
              total_tokens: 1150
            },
            last_token_usage: {
              input_tokens: 200,
              cached_input_tokens: 150,
              output_tokens: 25,
              reasoning_output_tokens: 10,
              total_tokens: 235
            }
          },
          rate_limits: {
            primary: { used_percent: 12 }
          }
        }
      })
    ].join('\n'));

    const event = await eventFromCodexHookPayload({
      hook_event_name: 'Stop',
      cwd: 'C:\\Users\\Chill\\vsCode\\antichurn',
      model: 'gpt-5',
      session_id: 'session_1',
      turn_id: 'turn_1',
      transcript_path: transcript
    });

    assert.equal(event.model, 'gpt-5');
    assert.equal(event.inputTokens, 200);
    assert.equal(event.cachedInputTokens, 150);
    assert.equal(event.outputTokens, 25);
    assert.equal(event.reasoningTokens, 10);
    assert.equal(event.metadata.usageSource, 'transcript:last_token_usage');
    assert.deepEqual(event.metadata.rateLimits, { primary: { used_percent: 12 } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('eventFromCodexTranscript records transcript usage without a hook payload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-'));
  const transcript = join(dir, 'rollout.jsonl');

  try {
    await writeFile(transcript, [
      JSON.stringify({
        timestamp: '2026-06-01T11:59:00.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5-codex' }
      }),
      JSON.stringify({
        timestamp: '2026-06-01T12:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 11,
              cached_input_tokens: 7,
              output_tokens: 5,
              reasoning_output_tokens: 3
            }
          }
        }
      })
    ].join('\n'));

    const event = await eventFromCodexTranscript(transcript, {
      cwd: 'C:\\Users\\Chill\\vsCode\\Codex-AI-Usage'
    });

    assert.equal(event.project, 'Codex-AI-Usage');
    assert.equal(event.model, 'gpt-5-codex');
    assert.equal(event.totalTokens, 26);
    assert.equal(event.metadata.transcriptPath, transcript);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('findLatestCodexTranscript returns the newest Codex JSONL transcript', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-'));
  const olderDir = join(dir, 'sessions', '2026', '06', '01');
  const newerDir = join(dir, 'archived_sessions');
  const older = join(olderDir, 'older.jsonl');
  const newer = join(newerDir, 'newer.jsonl');

  try {
    await mkdir(olderDir, { recursive: true });
    await mkdir(newerDir, { recursive: true });
    await writeFile(older, '{}\n');
    await writeFile(newer, '{}\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(newer, '{"newer":true}\n');

    assert.equal(await findLatestCodexTranscript({ codexHome: dir }), newer);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('defaultHookLogPath writes hook logs under the project cwd', () => {
  assert.equal(
    defaultHookLogPath({ cwd: 'C:\\Users\\Chill\\vsCode\\Codex-AI-Usage' }),
    'C:\\Users\\Chill\\vsCode\\Codex-AI-Usage\\.ai-usage\\events.jsonl'
  );
});

test('aggregateEvents groups usage and sums known costs', () => {
  const events = [
    trackEvent({
      timestamp: '2026-06-01T12:00:00Z',
      project: 'antichurn',
      model: 'gpt-5',
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.01
    }),
    trackEvent({
      timestamp: '2026-06-01T13:00:00Z',
      project: 'antichurn',
      model: 'gpt-5',
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.02
    }),
    trackEvent({
      timestamp: '2026-06-02T12:00:00Z',
      project: 'demo',
      model: 'gpt-4.1',
      inputTokens: 1,
      outputTokens: 1
    })
  ];

  const summary = aggregateEvents(events, {
    since: '2026-06-01T00:00:00Z',
    until: '2026-06-01T23:59:59Z',
    groupBy: ['project', 'model']
  });

  assert.equal(summary.eventCount, 2);
  assert.equal(summary.rows.length, 1);
  assert.equal(summary.rows[0].inputTokens, 110);
  assert.equal(summary.rows[0].costUsd, 0.03);
  assert.equal(summary.totals.totalTokens, 165);
});

test('estimateCostUsd uses caller supplied pricing data', () => {
  const event = trackEvent({
    timestamp: '2026-06-01T12:00:00Z',
    model: 'custom-model',
    inputTokens: 1_000_000,
    cachedInputTokens: 500_000,
    outputTokens: 250_000
  });

  assert.equal(estimateCostUsd(event, {
    'custom-model': {
      inputPerMillion: 2,
      cachedInputPerMillion: 0.5,
      outputPerMillion: 8
    }
  }), 4.25);
});

test('formatReport renders an empty state', () => {
  const report = formatReport(aggregateEvents([], { groupBy: ['model'] }));
  assert.equal(report, 'No usage events found for the selected range.');
});

test('loadEvents points to invalid JSONL lines', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ai-usage-'));
  const log = join(dir, 'events.jsonl');

  try {
    await writeFile(log, '{"model":"gpt-5"}\nnot-json\n');
    await assert.rejects(() => loadEvents(log), /line 2/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
