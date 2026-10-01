# Contributing

Use Node.js 22.13+; CI also verifies Node 24. Install dependencies with `npm ci`.

## Development

```sh
npm run dev
npm run check
npm run build
npm run test:integration
```

The development server binds to loopback on port 3410. Never use real customer specs, personal data or credentials in fixtures, screenshots or issues.

## Changes to the editor or persistence

Preserve source outside the selection, optimistic versions, JSON validation, undo/redo and the atomic relationship between JSON and generated exports. ADR review state and decision state are independent. An agent must not change decision status.

Add a regression test for a reproduced defect. Test the actual user interaction for focus, keyboard or layout changes; a parser test alone does not verify browser behavior. Keep the Zen presentation and respect reduced-motion preferences.

## Changes to GitLab Pages

```sh
HOOSPEC_PAGES_PATH=hoospec npm run build:pages
HOOSPEC_PAGES_PATH=hoospec npm run test:pages
```

Static builds must not contain server routes, local workspaces or secrets. Verify a nested URL, public OAuth with PKCE, project membership, read-only navigation and protected branches. `npm run test:gitlab` is optional and requires an explicitly disposable local instance; see [the testing guide](docs/testing.md).

## Pull requests

Explain the problem, change and verification. Include a screenshot for visible UI changes. Keep dependency lockfiles in sync, include relevant docs and describe any deployment or migration impact. CI runs on pull requests without production credentials and has read-only repository permission.

Do not publish security-sensitive findings in ordinary issues; follow [SECURITY.md](SECURITY.md).

## License

Contributions are submitted under the project's Apache-2.0 license. Preserve notices for any third-party code you include.
