# Codex AI Usage Tracker

Small local utility for tracking AI usage from Codex-oriented workflows. It records usage events as JSONL, then reports totals by day, model, project, session, or source.

## Requirements

- Node.js 20 or newer

## Usage

When installed as a Codex plugin, the included hook records usage automatically after Codex runs complete.

Record a usage event:

```powershell
node bin/ai-usage.js record --model gpt-5 --input 1200 --output 450 --project my-project --session local
```

Generate a table report:

```powershell
node bin/ai-usage.js report --by day,model,project
```

Export grouped usage as JSON:

```powershell
node bin/ai-usage.js export --by day,project,model
```

The default log file is `.ai-usage/events.jsonl`. Override it with `--log path/to/events.jsonl` or the `AI_USAGE_LOG` environment variable.

The `.jsonl` extension is intentional: it is JSON Lines, with one JSON event per line. That lets the tracker append each completed Codex run without rewriting a single large `.json` array.

## Optional Cost Estimates

The tracker does not ship with pricing tables. To estimate costs, pass a pricing JSON file:

```json
{
  "gpt-5": {
    "inputPerMillion": 1.25,
    "cachedInputPerMillion": 0.125,
    "outputPerMillion": 10
  }
}
```

Then run:

```powershell
node bin/ai-usage.js report --pricing pricing.json
```

You can also record known cost directly:

```powershell
node bin/ai-usage.js record --model gpt-5 --input 1200 --output 450 --cost 0.0042
```

## Codex Plugin Metadata

This repo includes `.codex-plugin/plugin.json`, `hooks/hooks.json`, and `skills/ai-usage/SKILL.md` so the utility can be used from Codex plugin workflows.

The hook runs:

```powershell
node scripts/codex-usage-hook.js
```

Codex hook payloads currently expose session metadata such as `model`, `session_id`, `turn_id`, and `transcript_path`. If a future hook payload includes direct `usage` data, the tracker records that. Otherwise, it reads the latest `token_count` event from the transcript and records `last_token_usage`. If Codex invokes the hook without stdin payload data, the hook falls back to the newest transcript under the local Codex sessions folder.

The manual plugin entrypoint is:

```powershell
node bin/ai-usage.js
```

## Reusing Across Projects

This plugin is not tied to a single repository. Use `--project <name>` for manual records, or set `AI_USAGE_PROJECT` in each workspace to label automatic hook records.

```powershell
$env:AI_USAGE_PROJECT = "my-project"
```

## Development

Run tests:

```powershell
npm test
```
