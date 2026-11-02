# Running Paperclip agents on NVIDIA NIM

> **New:** Company OS implements Paperclip's control-plane vocabulary natively
> (companies → departments → agents → goals → issues → budgets → approvals) on
> NVIDIA NIM, and can mirror a company into a live Paperclip server. See
> [`company-os.md`](company-os.md).

Paperclip (`../paperclip`) routes agent runs through AI connections. NVIDIA NIM
speaks the OpenAI **Chat Completions** shape, which Paperclip already supports as
a first-class gateway (`chat-completions-api`), so no provider enum change is
needed — only a connection and a model id.

## 1. Connect NIM as a Chat Completions gateway

Paperclip stores connections per company: **Company → Settings → Connections →
Apps → "Chat Completions API"** (catalog slug `chat-completions-api`).

Use these values:

| Field | Value |
| --- | --- |
| Name | `NVIDIA NIM` |
| Base URL | `https://integrate.api.nvidia.com/v1` |
| API key | your `nvapi-…` key from [build.nvidia.com](https://build.nvidia.com) |
| Protocol | `chat` (OpenAI-compatible) |
| Adapters | `opencode_local` or `hermes_local` (both route through the chat protocol) |
| Model id | e.g. `nvidia/nemotron-3-super-120b-a12b`, `meta/llama-3.3-70b-instruct` |

This maps onto Paperclip's existing routing contract
(`packages/shared/src/ai-provider-routing.ts`): a `gateway` route with
`protocol: "chat"`, `auth: "bearer"`, and the base URL above. The key is stored
through Paperclip's secret service and injected as `OPENAI_API_KEY` for the
harness, so it never appears in agent config or logs.

To verify from the host first:

```bash
curl -s https://integrate.api.nvidia.com/v1/chat/completions \
  -H "Authorization: Bearer $NVIDIA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"meta/llama-3.3-70b-instruct","messages":[{"role":"user","content":"ping"}],"max_tokens":16}'
```

### Model ids worth pinning

| Job | Model |
| --- | --- |
| Planner / reviewer | `nvidia/nemotron-3-super-120b-a12b`, `nvidia/llama-3.1-nemotron-ultra-253b-v1` |
| Fast execution | `nvidia/nemotron-3-nano-30b-a3b`, `deepseek-ai/deepseek-v4-flash` |
| Coding | `qwen/qwen2.5-coder-32b-instruct`, `qwen/qwen3-next-80b-a3b-instruct` |
| Retrieval embeddings | `nvidia/llama-3.2-nv-embedqa-1b-v2` |
| Reranking | `nvidia/llama-3.2-nv-rerankqa-1b-v2` |
| Safety | `nvidia/llama-3.1-nemotron-safety-guard-8b-v3` |

Model availability changes; `GET /v1/models` (and this app's **Models & routing**
screen) lists what your key can actually reach.

## 2. Keep Paperclip's governance, use NIM's inference

Nothing about Paperclip's guarantees changes: heartbeats, budgets, approvals,
task checkout rules and audit logs still own the run. Only the inference
credential and endpoint change.

## 3. Use this app as the retrieval and autopilot sidecar

Two patterns work well side by side:

1. **Company knowledge for Paperclip agents.** Load documents into this app
   (**Knowledge & RAG**), index them, then expose retrieval to Paperclip through
   that app's HTTP API:

   ```bash
   curl -s localhost:8787/api/knowledge/search \
     -H 'content-type: application/json' \
     -d '{"query":"what is our activation target?","topK":4}'
   ```

   Paperclip agents can call that endpoint as a tool, or the same embed/rerank
   pair can be replicated with a Paperclip custom tool.

2. **Goal-level orchestration above the board.** Paperclip runs the org —
   agents, tasks, budgets. This app runs a *cycle*: one goal → plan → reviewed
   deliverables → executive report. Use the report's "next actions" to seed
   Paperclip tasks, or point the autopilot at a goal that mirrors a Paperclip
   company goal so both views agree on the numbers.

## 4. Self-hosted NIM

For air-gapped or GPU-resident deployments, run the NIM containers and point
both systems at them:

```bash
docker run --gpus all -e NGC_API_KEY -p 8000:8000 \
  nvcr.io/nim/nvidia/llama-3.3-nemotron-super-49b-v1.5:latest
```

- Paperclip base URL: `http://<gpu-host>:8000/v1` (gateway, `chat` protocol —
  Paperclip permits HTTP only for loopback addresses, so front a remote NIM with
  HTTPS or a local tunnel).
- This app: set **Settings → Endpoints** to the same base URL.

Nothing else changes: the request shapes, model ids and tool-calling behaviour
are identical between hosted and self-hosted NIM.
