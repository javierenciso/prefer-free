# prefer-free

An **OpenCode plugin** that swaps paid `opencode-go/*` models for free ones, automatically, every time you start a session. You save credits without doing anything.

Whenever possible it picks the **exact same model on a free tier**. NVIDIA NIM hosts the same `kimi-k2.6`, `deepseek-v4-flash`, `deepseek-v4-pro`, etc. for free (with rate limits). If those aren't available, it falls back to OpenRouter `:free` models and OpenCode Zen free models.

## What it does

Every time a session starts (or a sub-task is spawned), the plugin:

1. Checks that `/prefer-free` is on.
2. Loads a list of currently-free models (NVIDIA NIM + OpenRouter `:free` + OpenCode Zen). This list is cached and refreshed every 6 hours in the background, so it never slows down startup.
3. Replaces each paid `opencode-go/*` model with a free model of similar quality.
4. Rotates between candidates across sessions, so it doesn't keep hitting the same model if one is slow.

### Default swaps

| Paid model (opencode-go) | First free choice                            | If that's busy, it tries |
|--------------------------|----------------------------------------------|--------------------------|
| `deepseek-v4-flash`      | `nvidia/deepseek-ai/deepseek-v4-flash` *(same model)* | qwen3-coder-480b, zen, llama-3.3-70b |
| `qwen3.5-plus`           | `nvidia/qwen/qwen3.5-122b-a10b` *(same family)*       | qwen3.5-397b, qwen3-coder-480b, zen, llama-3.3-70b |
| `kimi-k2.6`              | `nvidia/moonshotai/kimi-k2.6` *(same model)*          | qwen3-coder-480b, deepseek-v4-flash, zen, llama-3.3-70b |
| `deepseek-v4-pro`        | `nvidia/deepseek-ai/deepseek-v4-pro` *(same model)*   | nemotron-ultra-253b, nemotron-3-super-120b, zen, llama-3.3-70b |

If NVIDIA NIM can't be used (no API key, model removed, rate-limited, or you're offline), the plugin uses the built-in OpenCode Zen free models instead (`mimo-v2.5-free`, `nemotron-3-super-free`, `deepseek-v4-flash-free`).

## Auto-retry when a free model gets stuck

Free models hit rate limits and sometimes just stop responding. When the free model you're using gets stuck **in the middle of a task**, the plugin notices and **retries the same task on the next free model** — you don't have to watch for it or do anything.

It retries when any of these happen:

- **Rate limit / 429** — OpenCode keeps retrying the same model; after 3 failed attempts the plugin moves on.
- **Model error** — an error that looks like a quota, overload, or rate-limit problem.
- **No response** — the session is working but hasn't produced anything for 3 minutes, so the plugin assumes it's stuck. (A long but healthy tool call, like a build or test, counts as activity and won't trigger this.)

When it retries, it stops the stuck attempt, goes back to your last message, and sends it again using the **next free model in the list** (for example `nvidia/moonshotai/kimi-k2.6` → `nvidia/qwen/qwen3-coder-480b-a35b-instruct`). There's a 60-second cooldown per session so it never gets stuck in a retry loop, and each new failure moves one step further down the list.

If **every free model in the list has failed**, the plugin shows a notification and pauses the session so you can pick a model yourself. It **never quietly switches back to the paid model**. You can turn this whole feature on or off with `/prefer-free failover on|off` (it's on by default), and every retry shows up in `/prefer-free log`.

## Install

### 1. Copy the plugin

```bash
cp prefer-free.ts ~/.config/opencode/plugins/
```

### 2. (Optional, recommended) Turn on NVIDIA NIM

Get a free API key at https://build.nvidia.com → "Get API Key".

Add the key to your shell:

```bash
export NVIDIA_API_KEY="nvapi-..."
# add this line to ~/.zshrc so it sticks
```

Add the NVIDIA provider to `~/.config/opencode/opencode.json`:

```jsonc
{
  "provider": {
    "nvidia": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "NVIDIA NIM (free tier)",
      "options": {
        "baseURL": "https://integrate.api.nvidia.com/v1",
        "apiKey": "{env:NVIDIA_API_KEY}"
      },
      "models": {
        "moonshotai/kimi-k2.6":                          { "name": "Kimi K2.6 (NIM)",                    "tool_call": true },
        "deepseek-ai/deepseek-v4-flash":                 { "name": "DeepSeek V4 Flash (NIM)",            "tool_call": true },
        "deepseek-ai/deepseek-v4-pro":                   { "name": "DeepSeek V4 Pro (NIM)",              "tool_call": true },
        "qwen/qwen3-coder-480b-a35b-instruct":           { "name": "Qwen3 Coder 480B (NIM)",             "tool_call": true },
        "qwen/qwen3.5-122b-a10b":                        { "name": "Qwen3.5 122B (NIM)",                 "tool_call": true },
        "qwen/qwen3.5-397b-a17b":                        { "name": "Qwen3.5 397B (NIM)",                 "tool_call": true },
        "meta/llama-3.3-70b-instruct":                   { "name": "Llama 3.3 70B Instruct (NIM)",       "tool_call": true },
        "nvidia/llama-3.3-nemotron-super-49b-v1.5":      { "name": "Nemotron Super 49B v1.5 (NIM)",      "tool_call": true },
        "nvidia/llama-3.1-nemotron-ultra-253b-v1":       { "name": "Nemotron Ultra 253B (NIM)",          "tool_call": true },
        "nvidia/nemotron-3-super-120b-a12b":             { "name": "Nemotron 3 Super 120B (NIM)",        "tool_call": true }
      }
    }
  }
}
```

If you skip this step, the plugin just ignores NVIDIA NIM and uses Zen instead.

> **Note:** keep your real key out of any file you commit. Always use `{env:NVIDIA_API_KEY}` in the config and set the actual key as an environment variable.

### 3. Register the plugin

Add it to the `"plugin"` list in `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": [
    "/Users/youruser/.config/opencode/plugins/prefer-free.ts"
  ]
}
```

And register the command so autocomplete works:

```jsonc
{
  "command": {
    "prefer-free": {
      "description": "Toggle free model swapping / view swap log",
      "template": "[on|off|failover|log|clear|refresh|catalog|help]"
    }
  }
}
```

### 4. Done

Restart OpenCode. The plugin is **on by default**.

## Commands

| Command                      | What it does |
|------------------------------|--------------|
| `/prefer-free`               | Show the current status |
| `/prefer-free help`          | Show full help |
| `/prefer-free on`            | Turn free swapping on (default) |
| `/prefer-free off`           | Turn it off — use the original paid models |
| `/prefer-free failover on`   | Turn auto-retry on stuck models on (default) |
| `/prefer-free failover off`  | Turn auto-retry off — a stuck model stays stuck |
| `/prefer-free log`           | Show the last 30 swaps, retries, and catalog changes |
| `/prefer-free clear`         | Clear the log |
| `/prefer-free refresh`       | Refresh the free-model list right now (NIM + OpenRouter + Zen) |
| `/prefer-free catalog`       | Show the cached free-model list and how old it is |

## Files it creates

| File | What it's for |
|------|---------------|
| `~/.config/opencode/.prefer-free-state.json`   | On/off state + rotation position |
| `~/.config/opencode/.prefer-free-log`          | History of swaps and retries (capped at 100 MB) |
| `~/.config/opencode/.prefer-free-catalog.json` | Cached free-model list (refreshed every 6h) |

## How rotation works

If a free model is slow or rate-limited, the **next session** automatically tries a different one. The plugin remembers where it was per model, so it keeps moving through the list across sessions.

Example: if `opencode-go/kimi-k2.6` was swapped to `nvidia/moonshotai/kimi-k2.6` last time and that timed out, next time it tries `nvidia/qwen/qwen3-coder-480b-a35b-instruct`.

## How the free-model list stays fresh

The plugin keeps a cached list of free models and refreshes it every 6 hours. The refresh runs in the background, so your current session always uses the cached list and never waits.

When the list updates, the plugin compares it to the old one and logs anything added or removed. That's how you notice when NVIDIA drops a model or a new free model shows up.

Run `/prefer-free refresh` to update the list right away, and `/prefer-free catalog` to see what's currently free.

## License

MIT
