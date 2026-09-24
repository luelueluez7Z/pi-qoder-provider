# pi-provider-qoder

> **⚠️ 仅供学习研究使用（For learning and research purposes only）**
>
> 本项目仅用于学习、研究和个人技术探索，不保证稳定性与正确性，请勿用于生产环境或任何商业用途。使用本项目接入第三方 API 时，请遵守相关服务条款与法律法规，风险自负。
>
> This project is for **learning and research purposes only**. It is not guaranteed to be stable or correct. Do not use it in production or for any commercial purpose. When connecting to third-party APIs, please comply with the relevant terms of service and applicable laws. Use at your own risk.

A [pi](https://shittycodingagent.ai/) extension that connects pi to the **Qoder AI API** as a pure model provider. It exposes Qoder Global and Qoder China models through the standard pi provider surface, so pi keeps its own agent loop and tools while the underlying model is served by Qoder.

> Based on [simonsmh/pi-provider-qoder](https://github.com/simonsmh/pi-provider-qoder) and the [minglu6 fork](https://github.com/minglu6/pi-provider-qoder) (auth/identity fixes + enterprise VPC support), with **actual reasoning-effort and context-window forwarding** implemented on top.

## Features

- **Two provider entries**
  - `qoder` — Global / international Qoder.
  - `qoder-cn` — Qoder China, forced to CN endpoints and independent of `QODER_REGION`.
- **Interactive login** — Global Qoder supports browser device-code flow or Personal Access Token (PAT); Qoder CN uses a PAT login entry.
- **PAT → job-token exchange** — a Qoder PAT (`pt-...`) is exchanged for a short-lived job token (`jt-...`), mirroring the official `qodercli` flow. The stored PAT is re-exchanged transparently when the token expires.
- **Two chat protocols** — `QODER_PROTOCOL=auto` (default) uses qodercli's OpenAI-compatible model server (`/model/v1/chat/completions`, native `tool_calls`) for every global model, and keeps the legacy COSY gateway only for CN; `v2` / `legacy` force one transport. See [Transport protocol](#transport-protocol-qoder_protocol).
- **COSY signing + WAF bypass** — full COSY signature headers (RSA/AES-CBC/MD5) and the `Encode=1` body obfuscation the legacy gateway expects.
- **Dynamic model catalog** — model limits, effort config and options are fetched from `/algo/api/v2/model/list` and cached locally; static fallbacks ship for both editions.
- **Reasoning / thinking support** — thinking is extracted live from the API `reasoning_content` channel and from HTML-like `thinking` tags inline in the content stream.
- **Reasoning effort (推理强度)** — pi's thinking level maps to Qoder's `reasoning_effort` wire parameter (`none`/`low`/`medium`/`high`/`xhigh`/`max`), so `/thinking`-style controls actually take effect. Models with an explicit effort surface (e.g. DeepSeek V4 `high`/`max`) expose those levels via `thinking` metadata.
- **Context window (上下文大小)** — honors your Qoder CLI preference from `~/.qoder/settings.json` (`model.contextWindow` / `model.preferences.<model>.contextWindow`) and sends it as the `context_window` wire parameter.
- **Secure auth** — PAT is exchanged for a short-lived job token and only the job-refresh token (`jrt-...`) is persisted; the plaintext PAT is never written into the credential `refresh` field. Identity is resolved from auth.json (matching the current token) → in-memory cache → `/userinfo`, never a placeholder userID.
- **Tool support** — pi's tools are forwarded to Qoder in OpenAI function format, so pi's `read`/`write`/`bash`/`subagent` etc. keep working.

## Quick start

```bash
npm install
npm run build
```

Then load the built extension from pi:

```bash
pi -e ./dist/index.js
```

Or install it into `~/.pi/agent/extensions/` for auto-discovery.

### Login

Global / international edition:

```
/login qoder
```

China edition:

```
/login qoder-cn
```

### Personal Access Token (PAT)

A Qoder PAT (`pt-...`) cannot authenticate API calls directly — the provider exchanges it for a short-lived job token automatically.

Global Qoder:

- Run `/login qoder` and choose **Use API Key (PAT)**, then paste the token.
- Or set `QODER_PERSONAL_ACCESS_TOKEN` (or `QODER_PAT`) before starting pi.
- `QODER_API_KEY` is also accepted and triggers the same automatic startup login.

Qoder China:

- Run `/login qoder-cn`, then paste the CN PAT.
- Or set `QODERCN_PERSONAL_ACCESS_TOKEN` (or `QODERCN_PAT`) before starting pi.
- `QODERCN_API_KEY` is also accepted and triggers the same automatic startup login.

### Region environment variables

```bash
export QODER_REGION=cn       # or QODER_BACKEND=cn / QODER_MODE=cn
```

Setting a CN PAT without a global PAT also auto-selects CN mode for the `qoder` entry, but the recommended explicit China entry is `/login qoder-cn` / `--provider qoder-cn`.

### Transport protocol (`QODER_PROTOCOL`)

Qoder exposes two chat protocols, and this provider can use either:

| | `v2` — model server (qodercli's current protocol) | `legacy` — COSY gateway |
|---|---|---|
| Endpoint | `POST https://api2-v2.qoder.sh/model/v1/chat/completions` | `POST https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation` |
| Auth | `Authorization: Bearer <token>` | COSY envelope signature (RSA + AES + MD5) |
| Body | Plain OpenAI JSON | `Encode=1` obfuscated JSON |
| Response | Plain `data: {...}` chunks + `data: [DONE]` | `{statusCodeValue, body}` envelopes |
| Tool calls | Native streaming `tool_calls` | DSML/XML text in the content channel |

```bash
export QODER_PROTOCOL=auto    # default: v2 where available, legacy otherwise
export QODER_PROTOCOL=v2      # force the model server (fails on models it does not serve)
export QODER_PROTOCOL=legacy  # force the COSY gateway
export QODER_MODEL_SERVER_HOST=api2-v2.qoder.sh  # override the model server host
```

`auto` sends every global turn to the model server; the CN provider keeps the
COSY gateway because the CN gateway has no `/model/v1` route yet. Every model in
Qoder's catalog is served there — the request declares `metadata.business`
(`product: "cli"`), which is what the model server uses to resolve the model
registry (without it, CLI-only keys such as `dfmodel` are rejected as
`invalid_model_error`). There is no local "legacy-only model" list, no name
mapping and no automatic fallback: a model the model server does not serve fails
with a message naming it, plus the `QODER_PROTOCOL=legacy` escape hatch.

Other differences worth knowing:

- Thinking level maps to `reasoning: { effort }`; `off` is sent as `none`.
- The model server reports tokens but no `credits`, so pi's per-session credit
  total stays at 0 while the token counts are accurate.
- The model server wraps long JSON chunks mid-token (a raw newline inside the
  payload), which the client repairs when framing SSE events.

### Queue auto-retry

When the model gateway reports that a model is queued (error code `10605`), the provider waits the server-suggested duration and automatically re-issues the same request instead of failing the turn. A short notice is shown in the reply while retrying; if the queue never clears, the friendly queue error is surfaced.

```bash
export QODER_QUEUE_RETRY_MAX=3   # max automatic retries after a queue response (default 3; 0 disables)
```

### Quota guard

When the account runs out of credits, the upstream answers the chat endpoint with HTTP 200 but never streams anything — the turn would hang with no output. The provider checks the quota endpoint before each request (cached for 60s) and fails fast with a friendly "额度已用完" message. As a fallback, a stream that delivers nothing for the idle window is aborted and reported:

```bash
export QODER_IDLE_TIMEOUT_MS=60000   # abort a stream with no data after N ms (default 60000; 0 disables)
```

### Network safety

All Qoder control requests and chat connection setup have an abortable timeout. A chat stream also has a total lifetime limit. Malformed SSE, premature EOF, and invalid tool arguments are reported as errors so pi can apply its bounded retry policy instead of treating a partial reply as successful:

```bash
export QODER_HTTP_TIMEOUT_MS=60000    # control requests and chat connection (default 60000; 0 disables)
export QODER_STREAM_TIMEOUT_MS=300000 # total open chat stream lifetime (default 300000; 0 disables)
```

## Endpoints

Global:

- PAT exchange: `https://openapi.qoder.sh/api/v1/jobToken/exchange`
- User info: `https://openapi.qoder.sh/api/v1/userinfo`
- Usage: `https://openapi.qoder.sh/api/v2/quota/usage`
- Model list gateway: `https://api3.qoder.sh/algo/api/v2/model/list?Encode=1`
- Chat, `QODER_PROTOCOL=v2`: `https://api2-v2.qoder.sh/model/v1/chat/completions`
- Chat, `QODER_PROTOCOL=legacy`: `https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation`

China:

- PAT exchange: `https://openapi.qoder.com.cn/api/v1/jobToken/exchange`
- User info: `https://openapi.qoder.com.cn/api/v1/userinfo`
- Usage: `https://openapi.qoder.com.cn/api/v2/quota/usage`
- Model / chat gateway: `https://gateway.qoder.com.cn/algo/api/v2/...`

## Models

### Global `qoder`

Exposes the backing model keys returned by Qoder, including:

- **Tier models**: `auto`, `ultimate`, `performance`, `efficient`, `lite`
- **Frontier models**: `qmodel` (Qwen3.7 Plus), `cmodel` (Cantus), `qmodel_preview` (Qwen3.8 Max Preview), `qmodel_latest` (Qwen3.7 Max), `dmodel` (DeepSeek V4 Pro), `dfmodel` (DeepSeek V4 Flash), `gm51model` (GLM 5.2), `kmodel` (Kimi K2.7 Code), `kmodel_latest` (Kimi K3), `mmodel` (MiniMax M3)

### China `qoder-cn`

Exposes friendly model IDs and maps them back to Qoder CN's internal keys at request time (e.g. `qwen3.7-max` → `qmodel_latest`, `deepseek-v4-pro` → `dmodel`).

## Usage

Once logged in, select any Qoder model in pi:

```
/model qwen3.7-plus
```

Or start directly:

```bash
pi --provider qoder-cn --model qwen3.7-plus
pi --provider qoder --model auto
```

## Architecture

```text
src/
├── index.ts            # Extension registration (qoder + qoder-cn)
├── cosy.ts             # COSY signature, machine ID, region/endpoints, CN model aliases
├── prepare.ts          # Shared prelude: identity, quota, model key, messages, tools
├── model-server.ts     # v2 transport (qodercli model server) + QODER_PROTOCOL switch
├── login.ts            # OAuth device flow + PAT login sequence
├── pat.ts              # PAT → job-token exchange + identity resolution
├── models.ts           # Model definitions and dynamic config cache
├── oauth.ts            # PAT / OAuth callback orchestrator
├── stream.ts           # Legacy COSY streaming handler (+ transport dispatch)
├── transform.ts        # Message conversions (OpenAI schema mapping)
├── thinking-parser.ts  # Fallback thinking tag parser
├── qoder-encoding.ts   # WAF bypass body encoder (legacy transport)
└── usage.ts            # Quota/usage fetch
```

## Development

```bash
npm run check    # TypeScript type check
npm run lint     # Biome lint
npm test         # Vitest tests
npm run build    # esbuild bundle to dist/index.js
```

## License

MIT
