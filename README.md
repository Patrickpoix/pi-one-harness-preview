# Pi-One — AI Agent Harness

**An independently developed Harness for long-horizon AI Agent work, built on the open-source Pi ecosystem.**

Pi-One focuses on the engineering layer around capable models: **workflow orchestration, context and Skill routing, Worker responsibility, execution authority, recovery, Desktop/Remote convergence and evaluation**.

## Core ideas

- **Long-horizon workflow:** Goal / Plan / Todo / Frontier state keeps multi-step work coherent.
- **Dynamic context & Skill routing:** deeper capabilities are loaded according to task responsibility instead of every turn.
- **Worker responsibility:** delegated work carries bounded scopes, authority and verification expectations.
- **Recovery & continuation:** interrupted tasks can re-enter the same responsibility instead of restarting.
- **Desktop / Remote convergence:** different product surfaces share one canonical Session/runtime model.
- **MCP & multi-agent integration:** tools and sub-agents are capabilities inside one Harness.
- **Evaluation-driven development:** A/B, held-out and adversarial evaluations compare routing, context and architecture changes.

## Selected modules

- [`src/canonical-sources.mjs`](src/canonical-sources.mjs) — canonical Agent/Skill source discovery
- [`src/router.mjs`](src/router.mjs) — responsibility-oriented routing
- [`src/policy/capability-surface.mjs`](src/policy/capability-surface.mjs) — capability projection
- [`src/workflow/continuation.mjs`](src/workflow/continuation.mjs) — long-running continuation
- [`src/worker/authority.mjs`](src/worker/authority.mjs) — Worker execution authority
- [`src/worker/observability.mjs`](src/worker/observability.mjs) — Worker telemetry

## Technology

**TypeScript / JavaScript · AI Agent Harness · Prompt & Context Engineering · MCP · Multi-Agent · Desktop/Remote · evaluation & observability**

Pi-One builds on open-source Pi / pi Desktop work; upstream components retain their original authorship and licenses.
