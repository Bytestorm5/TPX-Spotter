# TPX-Spotter

Spotter (`@trusplex/spotter`) is the embeddable issue-capture SDK behind
Trusplex Console's support loop. Spotter captures, and Dispatcher classifies,
routes and resolves.

| Path                                             |                                                                                                                                                                   |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/spotter`                               | The SDK: `core` (capture, reporting API, transport, hooks, ingest handler) and `ui/next` (the Next.js integration). See its [README](packages/spotter/README.md). |
| `packages/spotter/schema/spotter.report.v1.json` | The published ticket schema                                                                                                                                       |
| `packages/ui`                                    | `@trusplex/ui`, the component kit: the widget's design system (tokens, stylesheet, React components) for any app. See its [README](packages/ui/README.md).        |
| `fixtures/next-app`                              | A Next.js App Router app that installs Spotter like a customer would, used for the Playwright e2e suite                                                           |
| `docs/`                                          | [Wire protocol](docs/protocol.md), [hooks](docs/hooks.md), [privacy, consent and CSP](docs/privacy.md), [self-hosting](docs/self-hosting.md)                      |

## Develop

```sh
pnpm install
pnpm typecheck
pnpm test             # vitest (node + happy-dom)
pnpm build            # tsc → dist, CLI, CDN bundles + SRI
pnpm check:size       # loader < 6 KB, core < 15 KB (gzip)
pnpm check:features   # every disabled feature is compiled out
pnpm test:e2e         # Playwright against fixtures/next-app
```

CI (`.github/workflows/ci.yml`) runs all of these. The budgets and the
feature check are release-blocking.

## Publish

Bump `version` in `packages/spotter/package.json` and/or
`packages/ui/package.json` (they version independently; publishing an
unchanged version is refused and skipped), commit, then from a clean `main`:

```sh
npm login             # once; needs publish rights on the @trusplex scope
pnpm publish:all      # build + pnpm check, then publish @trusplex/ui and @trusplex/spotter
```

`publish:all` builds and runs the full `pnpm check` first, so a failing test, budget or
feature check stops the release before anything reaches the registry.
`pnpm publish` also refuses a dirty tree or a branch other than `main`. To
inspect the tarball without publishing, run
`pnpm build && pnpm --filter @trusplex/spotter publish --dry-run --no-git-checks`.
