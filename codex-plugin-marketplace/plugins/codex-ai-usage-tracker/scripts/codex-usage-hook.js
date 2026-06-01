#!/usr/bin/env node

import {
  appendEventOnce,
  defaultHookLogPath,
  eventFromCodexHookPayload,
  eventFromCodexTranscript,
  findLatestCodexTranscript,
  readStdin
} from '../src/usage-tracker.js';

async function main() {
  const rawPayload = await readStdin();
  const payload = rawPayload.trim() ? JSON.parse(rawPayload) : {};

  const event = await eventFromCodexHookPayload(payload) ?? await eventFromLatestTranscript(payload);

  if (!event) {
    return;
  }

  const logPath = defaultHookLogPath(payload);
  await appendEventOnce(logPath, event);
}

async function eventFromLatestTranscript(payload) {
  const transcriptPath = payload.transcript_path ?? await findLatestCodexTranscript();
  if (!transcriptPath) {
    return null;
  }

  return eventFromCodexTranscript(transcriptPath, {
    cwd: payload.cwd ?? process.cwd(),
    hook_event_name: payload.hook_event_name ?? 'Stop',
    model: payload.model,
    session_id: payload.session_id,
    turn_id: payload.turn_id
  });
}

main().catch((error) => {
  console.error(`ai-usage codex hook failed: ${error.message}`);
  process.exitCode = 1;
});
