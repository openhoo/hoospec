# Hoospec

Next.js App Router, TypeScript, Tailwind v4 and real shadcn/ui components using Base UI.

- Fetch current library documentation through Context7 before library-specific changes.
- Use the Cucumber Gherkin AST for feature selection and validation. ADR Markdown uses validated heading ranges and explicit lifecycle metadata; ignore headings inside fenced code. Preserve source outside the selected range.
- Never expose AI keys in client components, API responses, logs, commits or test fixtures.
- Preserve optimistic version checks for every source or review mutation.
- Validate before saving; invalid or stale AI output must never overwrite saved content.
- Run `npm run lint`, `npm test`, `npm run build`, and `npm run test:integration` for changes to the editing pipeline.
- The local store supports one persistent Node.js process and one shared workspace. Do not deploy several replicas against it. GitLab Pages uses the separate browser repository adapter with canonical JSON and atomic GitLab commits.
- Pages must never include server routes or credentials. GitLab OAuth uses a public application with PKCE; keep tokens only in memory. Run build:pages when changing that deployment path.
- OpenHoo deployments go through hooapps-gitops and existing authentication. This local repository does not authorize identity or production changes.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
