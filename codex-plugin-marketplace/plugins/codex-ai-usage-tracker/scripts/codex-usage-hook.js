#!/usr/bin/env node

import {
  appendEventOnce,
  defaultLogPath,
  eventFromCodexHookPayload,
  readStdin
} from '../src/usage-tracker.js';

async function main() {
  const rawPayload = await readStdin();
  if (!rawPayload.trim()) {
    return;
  }

  const payload = JSON.parse(rawPayload);
  const event = await eventFromCodexHookPayload(payload);

  if (!event) {
    return;
  }

  const logPath = process.env.AI_USAGE_LOG ?? defaultLogPath();
  await appendEventOnce(logPath, event);
}

main().catch((error) => {
  console.error(`ai-usage codex hook failed: ${error.message}`);
  process.exitCode = 1;
});
