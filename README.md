# AI-xecutioner

Experiments in agent-run companies, all built on NVIDIA NIM.

| Directory | What it is |
| --- | --- |
| [`paperclip-nim/`](paperclip-nim/README.md) | **The deliverable.** A working clone of [Paperclip](https://github.com/paperclipai/paperclip) — agent company, issues, cycles, approvals, budgets, org chart — where every agent, skill, blueprint and model call runs on NVIDIA NIM: 97 models, 430 skills, 36 blueprints, every inference endpoint. Zero dependencies, one `npm start`. |
| `paperclip/` | Upstream Paperclip (MIT), kept for product parity reference. |
| `nvidia-autopilot/` | Earlier NIM autopilot prototype, kept for reference. |

## Run it

```bash
cd paperclip-nim
npm start          # http://localhost:8790 — simulation, no key needed
npm test           # 34 tests: catalogs, engine loop, HTTP surface
```

Add `NVIDIA_API_KEY=nvapi-…` (or paste a key into Settings) to switch the same code path to live inference.

See [`paperclip-nim/README.md`](paperclip-nim/README.md) for the product tour, [`docs/NIM.md`](paperclip-nim/docs/NIM.md) for endpoint coverage, and [`docs/API.md`](paperclip-nim/docs/API.md) for the HTTP API.
