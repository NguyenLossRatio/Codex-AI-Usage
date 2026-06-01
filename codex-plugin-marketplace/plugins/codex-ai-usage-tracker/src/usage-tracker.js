import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const GROUP_FIELDS = new Set(['day', 'model', 'project', 'session', 'source']);

export function defaultLogPath() {
  return process.env.AI_USAGE_LOG ?? '.ai-usage/events.jsonl';
}

export function trackEvent(input) {
  const timestamp = normalizeTimestamp(input.timestamp);
  const event = {
    id: input.id ?? randomUUID(),
    timestamp,
    day: timestamp.slice(0, 10),
    source: input.source ?? 'codex-plugin',
    project: input.project ?? process.env.AI_USAGE_PROJECT ?? null,
    session: input.session ?? process.env.CODEX_SESSION_ID ?? null,
    model: String(input.model),
    inputTokens: toNonNegativeInteger(input.inputTokens ?? 0, 'inputTokens'),
    outputTokens: toNonNegativeInteger(input.outputTokens ?? 0, 'outputTokens'),
    cachedInputTokens: toNonNegativeInteger(input.cachedInputTokens ?? 0, 'cachedInputTokens'),
    reasoningTokens: toNonNegativeInteger(input.reasoningTokens ?? 0, 'reasoningTokens'),
    costUsd: input.costUsd == null ? null : toNonNegativeNumber(input.costUsd, 'costUsd'),
    metadata: input.metadata ?? {}
  };

  event.totalTokens = event.inputTokens + event.outputTokens + event.cachedInputTokens + event.reasoningTokens;
  return event;
}

export async function appendEvent(logPath, event) {
  const absolutePath = resolve(logPath);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(event)}\n`, { flag: 'a' });
}

export async function appendEventOnce(logPath, event) {
  const events = await loadEvents(logPath);
  if (events.some((existing) => existing.id === event.id)) {
    return false;
  }

  await appendEvent(logPath, event);
  return true;
}

export async function loadEvents(logPath = defaultLogPath()) {
  let contents;
  try {
    contents = await readFile(logPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => parseEventLine(line, index + 1));
}

export function aggregateEvents(events, options = {}) {
  const groupBy = normalizeGroupBy(options.groupBy ?? ['model']);
  const filtered = events.filter((event) => withinRange(event, options));
  const groups = new Map();

  for (const event of filtered) {
    const keyParts = groupBy.map((field) => event[field] ?? '');
    const key = keyParts.join('\u001f');
    const existing = groups.get(key) ?? emptyRow(groupBy, keyParts);
    addEventToRow(existing, event, options.pricing);
    groups.set(key, existing);
  }

  const rows = [...groups.values()].sort(compareRows(groupBy));
  const totals = rows.reduce((total, row) => addRowToTotals(total, row), emptyTotals());

  return {
    generatedAt: new Date().toISOString(),
    range: {
      since: options.since ?? null,
      until: options.until ?? null
    },
    groupBy,
    eventCount: filtered.length,
    totals,
    rows
  };
}

export function estimateCostUsd(event, pricing = {}) {
  if (event.costUsd != null) {
    return event.costUsd;
  }

  const modelPricing = pricing[event.model];
  if (!modelPricing) {
    return null;
  }

  const inputCost = perMillion(event.inputTokens, modelPricing.inputPerMillion);
  const outputCost = perMillion(event.outputTokens, modelPricing.outputPerMillion);
  const cachedInputCost = perMillion(event.cachedInputTokens, modelPricing.cachedInputPerMillion);
  const reasoningCost = perMillion(event.reasoningTokens, modelPricing.reasoningPerMillion);
  const knownCosts = [inputCost, outputCost, cachedInputCost, reasoningCost].filter((value) => value != null);

  if (knownCosts.length === 0) {
    return null;
  }

  return roundCurrency(knownCosts.reduce((sum, value) => sum + value, 0));
}

export function formatReport(summary) {
  if (summary.rows.length === 0) {
    return 'No usage events found for the selected range.';
  }

  const columns = [
    ...summary.groupBy,
    'events',
    'input',
    'cached',
    'output',
    'reasoning',
    'total',
    'costUsd'
  ];

  const rows = summary.rows.map((row) => ({
    ...Object.fromEntries(summary.groupBy.map((field) => [field, row[field] || '-'])),
    events: row.events,
    input: row.inputTokens,
    cached: row.cachedInputTokens,
    output: row.outputTokens,
    reasoning: row.reasoningTokens,
    total: row.totalTokens,
    costUsd: row.costUsd == null ? '-' : row.costUsd.toFixed(6)
  }));

  const widths = Object.fromEntries(columns.map((column) => [
    column,
    Math.max(column.length, ...rows.map((row) => String(row[column]).length))
  ]));

  const header = columns.map((column) => pad(column, widths[column])).join('  ');
  const divider = columns.map((column) => '-'.repeat(widths[column])).join('  ');
  const body = rows.map((row) => columns.map((column) => pad(row[column], widths[column])).join('  '));
  const totalCost = summary.totals.costUsd == null ? '-' : summary.totals.costUsd.toFixed(6);

  return [
    header,
    divider,
    ...body,
    '',
    `Events: ${summary.eventCount}`,
    `Tokens: ${summary.totals.totalTokens}`,
    `Cost USD: ${totalCost}`
  ].join('\n');
}

export function toCsv(rows) {
  if (rows.length === 0) {
    return '';
  }

  const columns = Object.keys(rows[0]);
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(','))
  ].join('\n');
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function eventFromCodexHookPayload(payload) {
  const usageSource = getDirectUsage(payload) ?? await getTranscriptUsage(payload.transcript_path);

  if (!usageSource) {
    return null;
  }

  const usage = usageSource.usage;
  const timestamp = usageSource.timestamp ?? payload.timestamp;
  const turnId = payload.turn_id ?? usageSource.turnId ?? null;
  const sessionId = payload.session_id ?? null;
  const model = payload.model ?? usageSource.model;

  if (!model) {
    throw new Error('Codex hook payload did not include a model and no model was found in transcript usage');
  }

  return trackEvent({
    id: stableCodexEventId({
      sessionId,
      turnId,
      timestamp,
      usage
    }),
    timestamp,
    source: 'codex-hook',
    project: payload.project ?? projectFromCwd(payload.cwd),
    session: sessionId,
    model,
    inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
    outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
    cachedInputTokens: usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0,
    reasoningTokens: usage.reasoning_output_tokens ?? usage.reasoningTokens ?? 0,
    metadata: {
      hookEventName: payload.hook_event_name ?? null,
      turnId,
      cwd: payload.cwd ?? null,
      transcriptPath: payload.transcript_path ?? null,
      usageSource: usageSource.source,
      rateLimits: usageSource.rateLimits ?? null
    }
  });
}

export function parseDelimitedNumber(value, label) {
  if (typeof value === 'number') {
    return value;
  }
  return toNonNegativeInteger(String(value).replaceAll(',', ''), label);
}

async function getTranscriptUsage(transcriptPath) {
  if (!transcriptPath) {
    return null;
  }

  let contents;
  try {
    contents = await readFile(transcriptPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  let latest = null;
  let latestModel = null;
  let latestTurnId = null;

  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === 'turn_context' && entry.payload?.model) {
      latestModel = entry.payload.model;
    }

    if (entry.payload?.turn_id) {
      latestTurnId = entry.payload.turn_id;
    }

    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count') {
      const info = entry.payload.info;
      const usage = info?.last_token_usage ?? info?.lastTokenUsage ?? info?.total_token_usage;
      if (usage) {
        latest = {
          source: info?.last_token_usage || info?.lastTokenUsage ? 'transcript:last_token_usage' : 'transcript:total_token_usage',
          timestamp: entry.timestamp,
          turnId: entry.payload.turn_id ?? latestTurnId,
          model: entry.payload.model ?? latestModel,
          usage,
          rateLimits: entry.payload.rate_limits ?? null
        };
      }
    }
  }

  return latest;
}

function getDirectUsage(payload) {
  const usage = payload.usage ?? payload.token_usage ?? payload.tokenUsage;
  if (!usage) {
    return null;
  }

  return {
    source: 'hook:usage',
    timestamp: payload.timestamp,
    turnId: payload.turn_id,
    model: payload.model,
    usage,
    rateLimits: payload.rate_limits ?? payload.rateLimits ?? null
  };
}

function stableCodexEventId({ sessionId, turnId, timestamp, usage }) {
  const usageKey = [
    usage.input_tokens ?? usage.inputTokens ?? 0,
    usage.cached_input_tokens ?? usage.cachedInputTokens ?? 0,
    usage.output_tokens ?? usage.outputTokens ?? 0,
    usage.reasoning_output_tokens ?? usage.reasoningTokens ?? 0
  ].join('+');
  return `codex:${sessionId ?? 'unknown-session'}:${turnId ?? timestamp ?? 'unknown-turn'}:${usageKey}`;
}

function projectFromCwd(cwd) {
  if (!cwd) {
    return process.env.AI_USAGE_PROJECT ?? null;
  }
  return process.env.AI_USAGE_PROJECT ?? basename(cwd);
}

function parseEventLine(line, lineNumber) {
  try {
    const parsed = JSON.parse(line);
    return trackEvent(parsed);
  } catch (error) {
    throw new Error(`Invalid usage event on line ${lineNumber}: ${error.message}`);
  }
}

function normalizeTimestamp(timestamp) {
  const date = timestamp == null ? new Date() : new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid timestamp "${timestamp}"`);
  }
  return date.toISOString();
}

function toNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return number;
}

function toNonNegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label} must be a non-negative number`);
  }
  return number;
}

function normalizeGroupBy(groupBy) {
  const fields = Array.isArray(groupBy) ? groupBy : [groupBy];
  const normalized = fields.filter(Boolean);
  for (const field of normalized) {
    if (!GROUP_FIELDS.has(field)) {
      throw new Error(`Unsupported group field "${field}". Use one of: ${[...GROUP_FIELDS].join(', ')}`);
    }
  }
  return normalized.length === 0 ? ['model'] : normalized;
}

function withinRange(event, options) {
  const time = new Date(event.timestamp).getTime();
  const since = options.since ? new Date(options.since).getTime() : null;
  const until = options.until ? new Date(options.until).getTime() : null;

  if (since != null && time < since) {
    return false;
  }
  if (until != null && time > until) {
    return false;
  }
  return true;
}

function emptyRow(groupBy, keyParts) {
  return {
    ...Object.fromEntries(groupBy.map((field, index) => [field, keyParts[index] || null])),
    events: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: null
  };
}

function addEventToRow(row, event, pricing) {
  row.events += 1;
  row.inputTokens += event.inputTokens;
  row.cachedInputTokens += event.cachedInputTokens;
  row.outputTokens += event.outputTokens;
  row.reasoningTokens += event.reasoningTokens;
  row.totalTokens += event.totalTokens;

  const cost = estimateCostUsd(event, pricing);
  if (cost != null) {
    row.costUsd = roundCurrency((row.costUsd ?? 0) + cost);
  }
}

function emptyTotals() {
  return {
    events: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: null
  };
}

function addRowToTotals(total, row) {
  total.events += row.events;
  total.inputTokens += row.inputTokens;
  total.cachedInputTokens += row.cachedInputTokens;
  total.outputTokens += row.outputTokens;
  total.reasoningTokens += row.reasoningTokens;
  total.totalTokens += row.totalTokens;
  if (row.costUsd != null) {
    total.costUsd = roundCurrency((total.costUsd ?? 0) + row.costUsd);
  }
  return total;
}

function compareRows(groupBy) {
  return (left, right) => {
    for (const field of groupBy) {
      const comparison = String(left[field] ?? '').localeCompare(String(right[field] ?? ''));
      if (comparison !== 0) {
        return comparison;
      }
    }
    return 0;
  };
}

function perMillion(tokens, rate) {
  if (rate == null || tokens === 0) {
    return null;
  }
  return (tokens / 1_000_000) * Number(rate);
}

function roundCurrency(value) {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function pad(value, width) {
  return String(value).padEnd(width, ' ');
}

function csvCell(value) {
  if (value == null) {
    return '';
  }
  const string = String(value);
  return /[,"\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}
