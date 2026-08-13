# Changelog

## [0.4.8](https://github.com/runloopai/remote-agents-sdk/compare/remote-agents-sdk-v0.4.7...remote-agents-sdk-v0.4.8) (2026-08-13)


### Bug Fixes

* **sdk:** handle Codex MCP elicitation requests ([#162](https://github.com/runloopai/remote-agents-sdk/issues/162)) ([3d908ad](https://github.com/runloopai/remote-agents-sdk/commit/3d908add08253009a5d5e6ace01c28a5a5de922a))
* **sdk:** suppress unhandledRejection in PendingRequestMap.create() ([#161](https://github.com/runloopai/remote-agents-sdk/issues/161)) ([e4ca6f1](https://github.com/runloopai/remote-agents-sdk/commit/e4ca6f1d07999060a7002d884c9a3a85acaef14b))

## [0.4.7](https://github.com/runloopai/remote-agents-sdk/compare/remote-agents-sdk-v0.4.6...remote-agents-sdk-v0.4.7) (2026-07-17)


### Bug Fixes

* **sdk:** send thread and turn ids with codex turn/interrupt ([#149](https://github.com/runloopai/remote-agents-sdk/issues/149)) ([746b888](https://github.com/runloopai/remote-agents-sdk/commit/746b888f556e8830f434aa53b6191b8c21408613))

## [0.4.6](https://github.com/runloopai/remote-agents-sdk/compare/remote-agents-sdk-v0.4.5...remote-agents-sdk-v0.4.6) (2026-07-17)


### Features

* **sdk:** codex read/maintenance RPC wrappers (status, usage, mcp, skills, rename) ([#146](https://github.com/runloopai/remote-agents-sdk/issues/146)) ([c4ed6dd](https://github.com/runloopai/remote-agents-sdk/commit/c4ed6dda45fe89c0d414fd570f5f09966e15721e))
* **sdk:** codex thread-goal wrappers (thread/goal/set|get|clear) ([#147](https://github.com/runloopai/remote-agents-sdk/issues/147)) ([b8c0c09](https://github.com/runloopai/remote-agents-sdk/commit/b8c0c09078877525d2d255ea67becdbdae07b3a7))

## [0.4.5](https://github.com/runloopai/remote-agents-sdk/compare/remote-agents-sdk-v0.4.4...remote-agents-sdk-v0.4.5) (2026-07-15)


### Features

* **examples:** support Codex question tool (item/tool/requestUserInput) in combined-app ([#142](https://github.com/runloopai/remote-agents-sdk/issues/142)) ([8286128](https://github.com/runloopai/remote-agents-sdk/commit/8286128eec7c72e02a667246fc27a2839e542b65))
* **sdk:** add CodexAxonConnection and transport ([#135](https://github.com/runloopai/remote-agents-sdk/issues/135)) ([201da90](https://github.com/runloopai/remote-agents-sdk/commit/201da907e04ceacf0507ca913e0b40bc0910d170))
* **sdk:** vendor codex app-server protocol types and event classification ([#134](https://github.com/runloopai/remote-agents-sdk/issues/134)) ([1fc97c4](https://github.com/runloopai/remote-agents-sdk/commit/1fc97c4269bafa6f2fa54f6058c6837ead28d7a2))

## [0.4.4](https://github.com/runloopai/remote-agents-sdk/compare/remote-agents-sdk-v0.4.3...remote-agents-sdk-v0.4.4) (2026-06-26)


### Features

* **sdk:** make the published event `source` configurable ([#131](https://github.com/runloopai/remote-agents-sdk/issues/131)) ([89e5614](https://github.com/runloopai/remote-agents-sdk/commit/89e56146f266c27d812bf7111f9dd80e387eddca))

## [0.4.2](https://github.com/runloopai/remote-agents-sdk/compare/agent-axon-client-v0.4.1...agent-axon-client-v0.4.2) (2026-04-16)


### Features

* **sdk:** add typed runloop system events ([#98](https://github.com/runloopai/remote-agents-sdk/issues/98)) ([7763c99](https://github.com/runloopai/remote-agents-sdk/commit/7763c9969023fcc4e72bdf55e03e1f3de66cb3c2))
* **sdk:** add working dir, suspend resume to example app ([#100](https://github.com/runloopai/remote-agents-sdk/issues/100)) ([be15ce9](https://github.com/runloopai/remote-agents-sdk/commit/be15ce9cc6b036d6823bdc27646c7d398b143a47))

## [0.4.1](https://github.com/runloopai/remote-agents-sdk/compare/agent-axon-client-v0.4.0...agent-axon-client-v0.4.1) (2026-04-15)


### Features

* **examples:** add agent examples and compatability matrix generator ([#88](https://github.com/runloopai/remote-agents-sdk/issues/88)) ([52c86ba](https://github.com/runloopai/remote-agents-sdk/commit/52c86ba54a3e99b273765e30cd89120e6022780d))
* **sdk:** add link to docs from package & readme ([#91](https://github.com/runloopai/remote-agents-sdk/issues/91)) ([3d431fb](https://github.com/runloopai/remote-agents-sdk/commit/3d431fbec53b82d61d2d10731bfccd0e209e06d9))


### Bug Fixes

* **project:** update readme to reflect bugs fixed and new sdk support ([#87](https://github.com/runloopai/remote-agents-sdk/issues/87)) ([883cef3](https://github.com/runloopai/remote-agents-sdk/commit/883cef3b452a4e3d69531b21895a9e1883349082))

## [0.4.0](https://github.com/runloopai/remote-agents-sdk/compare/agent-axon-client-v0.3.0...agent-axon-client-v0.4.0) (2026-04-13)


### ⚠ BREAKING CHANGES

* **sdk:** unified timeline event stream, replay support, and multi-agent combined-app ([#65](https://github.com/runloopai/remote-agents-sdk/issues/65))

### Features

* **examples:** add combined-app demo with Claude + ACP support ([#59](https://github.com/runloopai/remote-agents-sdk/issues/59)) ([05ed899](https://github.com/runloopai/remote-agents-sdk/commit/05ed8991c67ed831464453f4c88fe6e3dceabce6))
* **sdk:** unified timeline event stream, replay support, and multi-agent combined-app ([#65](https://github.com/runloopai/remote-agents-sdk/issues/65)) ([9ac33ba](https://github.com/runloopai/remote-agents-sdk/commit/9ac33baf638dc50b80c71a4e831e5455191c413b))

## [0.3.0](https://github.com/runloopai/remote-agents-sdk/compare/agent-axon-client-v0.2.0...agent-axon-client-v0.3.0) (2026-04-07)


### ⚠ BREAKING CHANGES

* **sdk:** homogenize ACP and Claude connection APIs ([#48](https://github.com/runloopai/remote-agents-sdk/issues/48))

### Features

* **sdk:** homogenize ACP and Claude connection APIs ([#48](https://github.com/runloopai/remote-agents-sdk/issues/48)) ([cf3bfbf](https://github.com/runloopai/remote-agents-sdk/commit/cf3bfbfa5fd19f8dd228b72a7f645f10ccd77722))


### Bug Fixes

* **acp:** update event source for acp to be `acp-sdk-client` from `broker-transport` ([#51](https://github.com/runloopai/remote-agents-sdk/issues/51)) ([d9ae252](https://github.com/runloopai/remote-agents-sdk/commit/d9ae2521410e3e43db542547891a04475f759c27))
* **sdk:** harden error handling, lifecycle guards, and resource cleanup ([#50](https://github.com/runloopai/remote-agents-sdk/issues/50)) ([eda5c63](https://github.com/runloopai/remote-agents-sdk/commit/eda5c634186b62903a5ecb8a6d8dbeb2682230df))
* **sdk:** pass after_sequence on SSE reconnect to resume from last event ([#55](https://github.com/runloopai/remote-agents-sdk/issues/55)) ([03cbb45](https://github.com/runloopai/remote-agents-sdk/commit/03cbb45ee2c68204061f26d57b92dd5df8560baf))

## [0.2.0](https://github.com/runloopai/remote-agents-sdk/compare/agent-axon-client-v0.1.2...agent-axon-client-v0.2.0) (2026-04-03)


### ⚠ BREAKING CHANGES

* **sdk:** Connection constructor signatures and callback names changed.

### Features

* **claude:** add control request handler for mid turn agent control flow ([#35](https://github.com/runloopai/remote-agents-sdk/issues/35)) ([d6f1e35](https://github.com/runloopai/remote-agents-sdk/commit/d6f1e35dc0d27139f1ebe3e3e4f6565524fe873d))
* **sdk:** align ACP and Claude connection APIs ([#44](https://github.com/runloopai/remote-agents-sdk/issues/44)) ([a978c65](https://github.com/runloopai/remote-agents-sdk/commit/a978c65bb29670d80307932730e331ffc933f784))

## [0.1.2](https://github.com/runloopai/remote-agents-sdk/compare/agent-axon-client-v0.1.1...agent-axon-client-v0.1.2) (2026-04-02)


### Bug Fixes

* remove helper method for now ([#22](https://github.com/runloopai/remote-agents-sdk/issues/22)) ([89e85f9](https://github.com/runloopai/remote-agents-sdk/commit/89e85f90273be0d822261d0528e7e291b5238d0e))

## [0.1.1](https://github.com/runloopai/remote-agents-sdk/compare/agent-axon-client-v0.1.0...agent-axon-client-v0.1.1) (2026-04-02)


### Bug Fixes

* correct package.json for releasing NPM package ([#12](https://github.com/runloopai/remote-agents-sdk/issues/12)) ([b6e1496](https://github.com/runloopai/remote-agents-sdk/commit/b6e1496147188a6eea5127b1378fb51b11c62638))
