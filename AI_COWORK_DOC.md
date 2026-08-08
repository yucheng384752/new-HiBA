# AI_COWORK_DOC

> System note for future AI agents:
> This document records the current AI-assisted changes, known issues, verification results, and next steps. Read this before continuing work so you do not repeat prior investigation or overwrite unrelated user changes.

## 1. Known Bugs

* **[2026-05-21]** `[claw-dashboard / Generate Plan]` Planning flow fails when backend services are not running.
  * **Symptom**: In `scripts_pi/claw-dashboard.html`, entering a task and clicking `Generate Plan` calls the configured Planning URL. The current default is `http://localhost:8090/api/plan`.
  * **Observed failure**: Local checks showed `localhost:8090` was not reachable. Direct `POST /api/plan` returned "unable to connect to remote server".
  * **Related dependencies**: The planning agent also depends on Accounting at `http://localhost:9090` and an LLM endpoint at `http://localhost:11434/v1/chat/completions` unless configured otherwise.
  * **Current workaround/fix**: Dashboard now checks `GET {Planning URL}/health` before `POST /api/plan`, and keeps the error visible in the Plan panel instead of only showing a short toast.

* **[2026-05-21]** `[claw-dashboard / compact topology]` Text-only tree connectors were hard to read.
  * **Symptom**: The compact topology originally used text markers like `---` and `|_`, which aligned poorly and looked unstable.
  * **Current fix**: Compact topology now uses CSS-drawn right-angle connectors with a vertical trunk and horizontal branch lines.

## 2. Modified Scope

* **Date**: 2026-05-21
* **Files changed**:
  * `scripts_pi/claw-dashboard.html`
  * `AI_COWORK_DOC.md`
* **Unrelated pre-existing changes**:
  * `.claude/settings.json` was already modified before this documentation update. Do not revert it unless the user explicitly asks.
* **Change summary**:
  * Kept the full topology view's original node-card layout and Bezier SVG connector lines.
  * Added an animated transition when switching topology render modes.
  * When a user selects a node, the compact topology switches to a dashboard-to-node relationship tree.
  * Replaced fragile text connector glyphs with CSS right-angle connector lines.
  * Added `escapeHtml()` and escaped Plan error output before rendering it into the DOM.
  * Changed `generatePlan()` to normalize the Planning URL, check `/health`, then call `/api/plan`.
  * On Generate Plan failure, the Plan panel now displays a persistent error block with the failing Planning URL and dependency hint.

## 3. Before & After

### Compact topology display

* **Before**:
  * Full topology used cards and Bezier connector lines.
  * Compact topology still tried to show node relationships with text markers (`dashboard --- node1`, `|_ node2`), which did not read well.
* **After**:
  * Full topology remains unchanged: cards plus Bezier curves.
  * Compact topology renders `dashboard` as root and nodes as rows connected by CSS right-angle lines.
  * Active node remains highlighted and node status dots still show online/offline/checking state.
* **Reasoning**:
  * CSS connector lines preserve the "branch tree" idea without relying on monospace glyph alignment.

### Generate Plan error handling

* **Before**:
  * Failure was only shown in a short toast: `Plan failed: ...`.
  * The Plan panel did not preserve the error, so the user could miss what went wrong.
* **After**:
  * Dashboard checks `GET /health` on the configured Planning URL before sending the task to `/api/plan`.
  * Failure is stored in `workflowPlan.error` and rendered persistently in the Plan panel.
  * Error detail includes the exact Planning URL and reminds the operator to check Planning, Accounting, and LLM services.
* **Reasoning**:
  * The common failure mode is service availability/configuration, so the UI should make backend state obvious instead of silently returning to an empty plan.

## 4. Testing

* **Environment**: Windows PowerShell, Node.js available.
* **Checks run**:
  * [x] Inline script syntax check:
    * Command: `node -e "const fs=require('fs'); const s=fs.readFileSync('scripts_pi/claw-dashboard.html','utf8'); const m=s.match(/<script>([\s\S]*)<\/script>/); if(!m) throw new Error('script tag not found'); new Function(m[1]); console.log('inline script syntax ok');"`
    * Result: Pass.
  * [x] Backend `/api/plan` contract test:
    * Command: `npm.cmd test -- --runTestsByPath src/server/AgentServer.test.ts --testNamePattern="POST /api/plan"`
    * Working directory: `hiba-core/packages/hiba-agent`
    * Result: Pass, 2 tests passed.
  * [x] Direct local endpoint check:
    * `http://127.0.0.1:8090/api/plan` was not reachable in the current environment.
    * Result: Confirms the real local E2E flow is blocked by missing backend service startup, not by the endpoint contract test.
  * [ ] Browser E2E verification:
    * Not completed. Playwright CLI acquisition via `npx.cmd` timed out, and PowerShell blocks `npx.ps1`/`npm.ps1` by execution policy.

## 5. Next Steps for AI

1. If asked to verify the full UI flow, start the required services first:
   * `hiba-core`: `npm.cmd run accounting`
   * `hiba-core/packages/hiba-agent`: `npm.cmd run start:env`
   * Ensure the configured LLM endpoint and model are available.
2. Re-test in the browser:
   * Open `scripts_pi/claw-dashboard.html`.
   * Enter a natural language task.
   * Click `Generate Plan`.
   * Confirm that a successful response renders steps and changes the action button to Execute mode.
   * If services are offline, confirm the Plan panel shows the persistent error block.
3. Avoid reverting unrelated local changes, especially `.claude/settings.json`.
