# Security

## Report a vulnerability

Use the repository's **Security → Report a vulnerability** feature when private vulnerability reporting is enabled. If it is unavailable, open an issue asking for a private reporting channel without revealing the vulnerability or sensitive details. Never include access tokens, passwords, private specs or unredacted logs in a public report.

## Deployment boundaries

- **Node server:** one trusted workspace, one process, no built-in user authentication. Bind to loopback or place it behind an authenticated reverse proxy that protects the UI and every API / SSE endpoint. Origin checks protect browser writes; they are not authentication.
- **GitLab Pages:** enable GitLab Pages access control and set the project site to **Only project members**. This affects the whole website. The app additionally checks membership and branch push rights; GitLab enforces permissions on commits.
- **Agent bridge:** separate server-side AI key, exact allowed Pages origin and dedicated bridge token. Origin checks and browser project membership do not substitute for the bridge's own authentication. Use HTTPS for remote deployments.
- **Credentials:** OAuth access and refresh tokens and bridge credentials stay in browser memory. Only public connection settings may be persisted. Never put credentials in Pages configuration, `NEXT_PUBLIC_*`, screenshots or commits.
- **Data:** canonical JSON, generated documents and recoverable histories may contain sensitive material. Keep the repository or local data directory protected and back it up according to your own requirements.

## Supported version

This project is preparing its initial release. Apply fixes from the latest released version when releases are available. Dependency updates are proposed through Dependabot and verified by CI.
