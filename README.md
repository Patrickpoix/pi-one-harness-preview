# Pi-One Harness Preview

**A partial public source preview of Pi-One, an independently developed AI Agent Harness built on top of the open-source Pi ecosystem.**

> **Preview status:** this repository is intentionally incomplete and is **not the current Pi-One development branch**. Active development is continuing on private development branches in the main Pi-One repository. The full public source will be regenerated from the converged latest baseline after that work is complete.

This repository exists so reviewers can inspect representative Harness code without treating an in-progress development snapshot as a finished release.

## What is included

The preview exposes a small set of modules that illustrate the main engineering ideas:

- `src/architecture-profile.mjs` — bounded architecture/profile selection.
- `src/canonical-sources.mjs` — canonical Agent/Skill source discovery and identity handling.
- `src/router.mjs` — responsibility- and metadata-oriented Skill/Context routing.
- `src/policy/capability-surface.mjs` — capability/tool surface projection.
- `src/workflow/continuation.mjs` — long-horizon continuation control.
- `src/worker/authority.mjs` — Worker execution/authority contracts.
- `src/worker/observability.mjs` — bounded Worker execution telemetry.

Together they show the direction of Pi-One's Harness layer: keep simple work light, load deeper capabilities only when needed, preserve one canonical owner for state/authority, and make long-running Agent work observable and recoverable.

## What is intentionally omitted

This preview does **not** currently publish:

- the latest in-progress Pi-One runtime integration;
- the complete Desktop / Remote convergence implementation;
- the full Workflow / Worker implementation;
- the complete test and evaluation corpus;
- private experimental datasets or unpublished benchmark evidence;
- local configuration, credentials, model-provider state, or development worklogs.

Because those pieces are omitted, **this repository is not intended to be installed or built as a standalone Pi-One distribution**.

## Project context

Pi-One explores Harness-level problems that appear in long-horizon coding Agents, including:

- context growth and repeated reacquisition;
- Skill/tool routing and capability loading;
- Goal / Plan / Todo continuation across long tasks;
- Worker responsibility and execution authority;
- Desktop / Remote state convergence;
- evaluation, failure attribution, and human-reviewed promotion.

The optimization target is not to add restrictions for their own sake. It is to reduce execution friction while keeping correctness, state ownership and high-impact authority explicit.

## Upstream attribution

Pi-One is built on top of open-source Pi / pi Desktop work. Upstream components retain their original authorship and licenses. This preview only presents selected Pi-One Harness-layer files and does not claim authorship of upstream projects.

See [`NOTICE.md`](NOTICE.md) for attribution details.

## Release plan

Once the current private development/convergence work is finished, this preview will be superseded by a newly audited full public Pi-One repository generated from that final baseline.

## License

MIT. See [`LICENSE`](LICENSE).
