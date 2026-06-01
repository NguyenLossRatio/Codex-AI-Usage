#!/usr/bin/env node

import {
  appendEvent,
  appendEventOnce,
  aggregateEvents,
  defaultLogPath,
  eventFromCodexHookPayload,
  formatReport,
  loadEvents,
  parseDelimitedNumber,
  readStdin,
  readJson,
  toCsv,
  trackEvent
} from '../src/usage-tracker.js';

const COMMANDS = new Set(['record', 'codex-hook', 'report', 'export', 'help']);

async function main(argv) {
  const { command, flags, positionals } = parseCli(argv);

  if (command === 'help' || flags.help) {
    printHelp();
    return;
  }

  if (command === 'record') {
    const event = trackEvent({
      timestamp: flags.timestamp,
      source: flags.source ?? 'codex-plugin',
      project: flags.project,
      session: flags.session,
      model: required(flags.model, '--model is required'),
      inputTokens: parseDelimitedNumber(flags.input ?? flags.inputTokens ?? 0, 'input tokens'),
      outputTokens: parseDelimitedNumber(flags.output ?? flags.outputTokens ?? 0, 'output tokens'),
      cachedInputTokens: parseDelimitedNumber(flags.cachedInput ?? flags.cacheRead ?? 0, 'cached input tokens'),
      reasoningTokens: parseDelimitedNumber(flags.reasoning ?? 0, 'reasoning tokens'),
      costUsd: flags.cost == null ? undefined : Number(flags.cost),
      metadata: collectMetadata(flags.meta)
    });

    const logPath = flags.log ?? defaultLogPath();
    await appendEvent(logPath, event);
    console.log(JSON.stringify({ recorded: true, log: logPath, event }, null, 2));
    return;
  }

  if (command === 'codex-hook') {
    const payloadText = flags.payload ? await readFileAsJson(flags.payload) : await readStdin();
    if (!payloadText.trim()) {
      return;
    }

    const event = await eventFromCodexHookPayload(JSON.parse(payloadText));
    if (!event) {
      return;
    }

    const logPath = flags.log ?? defaultLogPath();
    const recorded = await appendEventOnce(logPath, event);
    if (flags.quiet !== true) {
      console.log(JSON.stringify({ recorded, log: logPath, event }, null, 2));
    }
    return;
  }

  if (command === 'report' || command === undefined) {
    const logPath = flags.log ?? defaultLogPath();
    const events = await loadEvents(logPath);
    const pricing = flags.pricing ? await readJson(flags.pricing) : undefined;
    const summary = aggregateEvents(events, {
      since: flags.since,
      until: flags.until,
      groupBy: splitList(flags.by ?? 'model'),
      pricing
    });

    if (flags.format === 'json') {
      console.log(JSON.stringify(summary, null, 2));
    } else if (flags.format === 'csv') {
      console.log(toCsv(summary.rows));
    } else {
      console.log(formatReport(summary));
    }
    return;
  }

  if (command === 'export') {
    const logPath = flags.log ?? defaultLogPath();
    const events = await loadEvents(logPath);
    const pricing = flags.pricing ? await readJson(flags.pricing) : undefined;
    const summary = aggregateEvents(events, {
      since: flags.since,
      until: flags.until,
      groupBy: splitList(flags.by ?? 'day,model'),
      pricing
    });
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  throw new Error(`Unknown command "${command}". Run ai-usage help.`);
}

function parseCli(argv) {
  const flags = {};
  const positionals = [];
  let command;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (COMMANDS.has(arg) && command === undefined) {
      command = arg;
      continue;
    }

    if (arg.startsWith('--')) {
      const [rawKey, inlineValue] = arg.slice(2).split('=', 2);
      const key = toCamelCase(rawKey);
      const next = argv[i + 1];
      const value = inlineValue ?? (next && !next.startsWith('--') ? argv[++i] : true);

      if (flags[key] === undefined) {
        flags[key] = value;
      } else if (Array.isArray(flags[key])) {
        flags[key].push(value);
      } else {
        flags[key] = [flags[key], value];
      }
      continue;
    }

    positionals.push(arg);
  }

  return { command, flags, positionals };
}

function collectMetadata(metaFlag) {
  const entries = Array.isArray(metaFlag) ? metaFlag : metaFlag == null ? [] : [metaFlag];
  return Object.fromEntries(entries.map((entry) => {
    const [key, ...rest] = String(entry).split('=');
    return [key, rest.join('=') || true];
  }));
}

function required(value, message) {
  if (value == null || value === '') {
    throw new Error(message);
  }
  return value;
}

function splitList(value) {
  if (Array.isArray(value)) {
    return value.flatMap(splitList);
  }
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printHelp() {
  console.log(`AI usage tracker

Usage:
  ai-usage record --model gpt-5 --input 1200 --output 450 [--project my-project]
  ai-usage codex-hook < codex-hook-payload.json
  ai-usage report [--by day,model] [--since 2026-06-01] [--format table|json|csv]
  ai-usage export [--by day,project,model]

Options:
  --log <path>          JSONL usage log. Default: .ai-usage/events.jsonl
  --pricing <path>      Optional model pricing JSON for cost estimates.
  --cost <usd>          Explicit known cost for a recorded event.
  --meta key=value      Extra metadata. Can be repeated.
  --payload <path>      Codex hook payload JSON for codex-hook.
  --quiet               Suppress codex-hook output.

Pricing file shape:
  {
    "gpt-5": {
      "inputPerMillion": 1.25,
      "outputPerMillion": 10,
      "cachedInputPerMillion": 0.125
    }
  }
`);
}

async function readFileAsJson(path) {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
