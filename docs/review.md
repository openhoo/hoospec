# Release review

Reviewed on **2026-10-02**. This report describes local verification and a disposable self-managed GitLab deployment. It does not claim a production rollout. The initial public GitHub CI run is recorded below.

## Changes made

### Editor and overview

- The start view is a calm, searchable overview with separate tables for Feature Specs and ADRs. Rows open documents with a click or keyboard activation. ADR rows show unanswered questions; ADR lifecycle is visible independently of the document title.
- The wordmark returns to the overview, flushing valid inline edits first. Invalid or conflicted drafts remain in the editor. The overview suspends document editing shortcuts and disables actions that would otherwise affect a hidden document.
- Previous/next navigation and review completion controls are removed. Existing persisted review metadata remains compatible with older workspaces.
- ADR lifecycle uses quiet text instead of a colored badge. Decisions are edited in their own section with double-click or Enter, with the same autosave and agent selection as other sections. Status changes remain explicit.
- The agent bar sits at the bottom without reserving space for a review footer. Both themes, mobile layout and reduced-motion preferences are supported.

### Runtime and data integrity

- Production startup uses the Next.js standalone server, includes static assets and resolves the workspace directory independently of the server's working directory. Loopback is the default binding; host and port are configurable.
- AI helper scripts accept deployment configuration and a key through protected stdin or a server environment variable. They contain no personal credential-store paths, account names or private model defaults.
- API bodies are bounded while streaming, before JSON parsing: 2 MB for workspace requests and 1 MB for the repository agent bridge. Split UTF-8 input is handled correctly.
- Disconnecting or cancelling an agent request aborts provider work. Server persistence checks cancellation inside its transaction, and the repository adapter checks it before committing.
- Bridge concurrency is checked again after asynchronous request parsing so simultaneous bodies cannot bypass the four-request limit. GitLab/OAuth requests and agent requests have bounded timeouts.
- GitLab persistence validates the complete serialized JSON manifest before committing, including source mappings and history. The 16 MB limit matches the read path, preventing the application from writing a workspace it cannot reload.
- Optimistic versions, selection rebasing, source validation and atomic JSON/generated-source commits remain enforced. Failed, stale, truncated or cancelled agent output does not replace saved documents.

### Installation and publication

- Apache-2.0 license, contributor notice and third-party shadcn/Geist license notices are included in source, container and Pages distributions.
- README, contribution guide, security policy, changelog, editor guide and testing guide document neutral setup and supported deployment modes.
- GitHub CI covers Node 22/24, lint, TypeScript, unit/integration tests, dependency audit, nested Pages export and a container persistence smoke test. Official checkout/setup actions are pinned to verified commit SHAs; checkout credentials are not persisted. Dependabot is configured.
- The GitLab installer copies an explicit publication allowlist. It excludes local runtime data, credentials and dependencies, rejects existing destinations and symlink targets, and installs through a staging directory.
- The Pages attachment works in a pre-existing Alpine Pages job without Node. It preserves the existing website and refuses an occupied path unless that path is a marked Hoospec output.
- Generated Pages staging directories and publication artifacts are excluded from lint and version control. Unused template assets were removed and a Hoospec icon added.

## Verification

| Check | Result |
| --- | --- |
| Unit tests | **69 passed** on Node 22.23.3 and 24.21.0; also passed on local Node 26.10.0 |
| Server integration | **27 passed**, isolated production server and local AI fixture |
| Lint / TypeScript / production build | Passed |
| GitLab API fixture | **7 checks passed** against disposable GitLab CE 19.4.1 |
| Nested Pages export | `/team/project/hoospec`; all referenced assets exist, licenses included, no API/server/workspace files or supplied server-key markers |
| Container | Production build passed; non-root serving, assets, real JSON save, foreign-origin rejection and volume persistence after restart passed |
| Dependency audit | **0 reported vulnerabilities**, full dependency tree |
| GitHub workflow | `actionlint` passed; initial public CI run 36941087038 passed for commit `774b495f66b1d0f4afd9e20fca900e43016eaab8` (Node 22/24, integration, nested Pages and container) |
| Publication secret scan | Gitleaks scan of the clean source snapshot passed with no findings |

### Live GitLab Pages

The reviewed application UI was deployed into an existing private test project. Pipeline **35**, deployment commit `60bd4a18db57b7872a415d60bba83f2e754704b4`, succeeded. Its Node 24 build job and existing Alpine Pages attachment job both succeeded. A subsequent cosmetic simplification removed overview copy, filenames and scenario counts and softened row hover; it was verified locally with lint, a production build and desktop/mobile browser inspection. Pipeline 35 predates that cosmetic change.

The original page at `/` remains intact alongside Hoospec at `/hoospec/`. Access checks confirmed that anonymous visitors must log in, project members are admitted, and authenticated nonmembers are denied. A Reporter can read documents but cannot save or start AI edits.

An ordinary user registered the public OAuth application without instance-admin rights. Earlier live browser checks verified PKCE login, writer autosave and undo, and a real model edit through the separately authenticated bridge with an atomic JSON/Gherkin commit. Fixture AI tests alone are not a claim about real model quality.

### Browser checks

- Overview search filters both document kinds; a keyboard-activated row opens the document.
- Enter opens an ADR section for direct editing. Returning to the overview saves the draft; reopening shows the saved decision text. Explicit status changes appear in the overview immediately.
- No previous/next navigation, review completion footer or separate decision dialog remains.
- Light and dark desktop layouts were visually inspected. At 390 px, both document and canvas widths were 390 px, with no horizontal overflow.
- Earlier editor checks verified no vertical shift from opening the unchanged title editor, table row insertion with the agent input still visible, Tab cell navigation, autosave and Ctrl+Z/Y.
- Final local browser console inspection returned no warnings or errors. Screenshots use isolated synthetic documents. The original studio's four document sources remained unchanged.

## Publication follow-up

The initial source was published publicly as `openhoo/hoospec` under Apache-2.0. GitHub CodeQL identified predictable temporary-file output in the optional live GitLab fixture. The fixture now uses an unpredictable private directory and an exclusive file creation with mode 0600. Its other reported flows are intentional: a user-supplied test credential is sent only to the explicitly configured loopback GitLab fixture, and non-secret API metadata is serialized as JSON for inspection. No scan or security control was disabled.

## Operating limits

GitLab Pages access control protects the **entire project website**. It cannot make only the Hoospec subpath private beside a public root. Initial activation of Pages access control on a self-managed instance requires its operator. A target installation also needs Pages, a usable runner, reachable GitLab APIs and trusted HTTPS certificates.

OAuth uses a public application with PKCE and keeps access/refresh tokens in memory. Membership and branch write permission are checked separately. A token used to provision a disposable test fixture is not the application's authentication method.

The Node server has no built-in end-user authentication. Use loopback for local work or an authenticated reverse proxy for shared hosting. Its persistent workspace supports one server process, not multiple replicas sharing the same data directory. GitLab Pages synchronizes saved repository commits through polling; presence, shared navigation and unsaved live drafts belong to Node mode. The optional agent bridge is a separate authenticated service.

The GitLab manifest is limited to 16 MB, including history. A large workspace needs archival or a future storage migration before exceeding that limit.

ESLint remains on 9.39.5. An attempted upgrade to ESLint 10 failed in the React plugin bundled with `eslint-config-next` 16.3.8 (`contextOrFilename.getFilename is not a function`). The working lint stack was restored; its dependency audit is clean. Upgrade this development tooling when the bundled plugin supports ESLint 10.

See [GitLab setup](gitlab.md), [editor workflow](editor.md), [testing](testing.md) and [security policy](../SECURITY.md).


## Controlled shared merge requests — October 2, 2026

The GitLab Pages workflow now collects edits in an automatically persisted, private per-tab browser draft. Creating a draft MR or synchronizing an existing MR is explicit and reviewed through a calm file diff. The target branch is never written by the studio workflow; normal GitLab review and merge controls govern acceptance. The workflow contains no manual workspace export/import controls.

- Team members can join the same workspace-specific MR branch; synchronized checkpoints are polled every 10 seconds.
- Conflicting local edits survive polling, reload and OAuth. Direct conflict choices can adopt the common checkpoint or retain locally changed documents on top of it without replacing other documents added by collaborators.
- Interrupted commits/MR requests are stored locally and retry without duplicate commits, including recovery after reload and a lost commit response. Source JSON comparison is semantic so migration/property ordering cannot prevent recovery.
- Local draft storage failure does not report an input as saved; credentials are excluded from persistence. Developers can propose changes to protected targets without direct target push rights. Commit validation and optimistic file checks remain enforced.
- Local verification: lint, 82 unit tests, production build and 27 server integration checks passed. Nested static Pages export and asset checks passed. Eight checks against the disposable GitLab CE instance passed, including an actual merge and target readback.
- Browser verification on the private existing-project Pages fixture: OAuth, MR creation, joining/leaving/rejoining, automatic unsynchronized draft recovery after reload/OAuth, and synchronizing another commit into the same MR. The initial MR had one commit while the newer local draft was visible; only the explicit synchronization added the second commit. Desktop and mobile dialog screenshots use synthetic test content.
- Test Pages pipeline 49 (`7b5e7ff608ebc8261512d580348d0f76f8e89009`) passed. This changes the earlier immediate-autosave commit behavior described in the original release evidence above. Node server collaboration remains independent of this Pages workflow.
