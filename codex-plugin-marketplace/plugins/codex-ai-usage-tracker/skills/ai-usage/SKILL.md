---
name: ai-usage
description: Record, inspect, summarize, or export local AI usage for Codex-assisted work.
---

# AI Usage Tracking

Use this skill when the user wants to record, inspect, summarize, or export AI usage for Codex-assisted work.

## Workflow

1. Prefer the automatic Codex hook in `hooks/hooks.json` when the plugin is installed.
2. Use `node bin/ai-usage.js record` for usage that does not pass through Codex hooks.
3. Include the model, input tokens, output tokens, and any known cached or reasoning tokens for manual records.
4. Use `--project`, `--session`, and `--meta key=value` to keep downstream reports useful.
5. Generate summaries with `node bin/ai-usage.js report --by day,model,project`.

## Examples

```powershell
node bin/ai-usage.js record --model gpt-5 --input 1200 --output 450 --project my-project --session local
node bin/ai-usage.js codex-hook --payload sample-codex-hook-payload.json
node bin/ai-usage.js report --by day,model --format table
node bin/ai-usage.js export --by day,project,model
```

## Notes

- The default log path is `.ai-usage/events.jsonl`.
- Set `AI_USAGE_LOG` to route usage into another file.
- Costs are only recorded when explicitly supplied with `--cost` or estimated from a user-provided `--pricing` JSON file.
- Hook payloads with direct `usage` are recorded as-is; otherwise the tracker reads `last_token_usage` from the Codex transcript referenced by `transcript_path`.
