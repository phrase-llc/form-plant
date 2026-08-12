# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

FormPlant is an embeddable contact-form widget for landing pages, hosted on Cloudflare Pages. A host page includes one `<script>` tag; the widget fetches a JSON form definition, renders the form client-side, and POSTs submissions to a Pages Function that verifies Cloudflare Turnstile and relays the message via AWS SES.

## Commands

```bash
npm install
npm run dev            # wrangler pages dev — serves ./public + ./functions at http://localhost:8788
npm run typecheck      # tsc — typecheck functions/ (no build step; Wrangler bundles TS directly)
npm run check:bundle   # build the Functions bundle and reject workerd-incompatible APIs
npm run check:client   # syntax-check public/contact-form.js and validate public/test.json
npx wrangler pages deploy   # deploy
```

Local test page: `http://localhost:8788/test.html` (uses `/test.json` as the form definition and the Turnstile always-pass test sitekey `1x00000000000000000000AA`).

There is no test suite, linter, or formatter configured. CI (`.github/workflows/ci.yml`) runs the three `npm run` checks above on every PR; beyond that, verification is a manual pass over the local test page. Node version is pinned by `.node-version` (26.7.0, currently not an LTS line) and CI reads that file, so a version that cannot be installed fails the build.

`check:bundle` exists because a dependency upgrade once shipped code that typechecked *and* bundled cleanly but died at runtime: the AWS SDK's browser-conditioned XML parser pulled in `DOMParser`, which workerd lacks. It scans the built bundle for such APIs and also fails on Wrangler's own `nodejs_compat` warning. See the header of `scripts/check-worker-bundle.mjs` before adding patterns — some obvious ones (`Buffer`, `window`) match guarded feature detection in the AWS SDK and will fail spuriously.

## Configuration

`wrangler.toml` is **gitignored** — copy `wrangler.toml.sample` to `wrangler.toml` and fill it in before running `npm run dev`. Required `[vars]`: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SES_FROM_ADDRESS`, `SES_TO_ADDRESS`, `TURNSTILE_SECRET_KEY`, `ALLOWED_ORIGINS`.

`ALLOWED_ORIGINS` is a comma-separated allowlist. Origins not on it get an empty `Access-Control-Allow-Origin`, so a cross-origin embed silently fails in the browser — add the LP's origin here (and `http://localhost:8788` for local testing). In production these are set as Pages environment variables/secrets, not in the committed file.

Note: earlier revisions read allowed origins and the Turnstile secret from a KV namespace. That was removed — everything now comes from `env`. Ignore leftover KV state in `.wrangler/`.

## Architecture

**`public/contact-form.js`** — a single IIFE, no build step, no dependencies. It reads its own `<script>` element via `document.currentScript`, so it must stay a classic synchronous script (not `type="module"`, not `async`/`defer`). Script attributes are the entire public API:

| attribute | meaning |
| --- | --- |
| `data-site-key` | identifies which stored configuration to use (required) |
| `data-form-url` | URL of the JSON form definition (required) |
| `data-api-url` | submit endpoint base; defaults to the script's own origin + `/api/submit` |

`data-lp` is gone. The email subject now takes its label from the stored site config, because a client-supplied identifier is not something the server should be putting in mail or routing on.

The widget does **not** take the form slug as an attribute: it reads `slug` from the fetched definition and builds `<api-base>/api/submit/<site-key>/<slug>`. Parsing it out of `data-form-url` would break as soon as someone wrote that URL differently.

It renders into `#contact-form` on the host page and does nothing if that element is absent.

**Form definition JSON** (`public/test.json` is kept as a schema reference; `test.html` now fetches its definition from KV like a real embed does) drives everything: `{ messages?, fields[] }`, or a bare array of fields. Each field has `name`, `label`, `type` (`text`/`email`/`textarea`/`select`/`radio`/`checkbox`/`turnstile` — anything else falls through to an `<input>` of that type), optional `required`, `options[]` for select/radio, and `validation` (`pattern`, `minLength`, `maxLength`, `message`). Adding a field type means touching `renderField()` and, if its value isn't read off `form.elements[name].value`, the submit handler and `validateField()` too.

A `turnstile` field is special-cased: it injects the Cloudflare Turnstile script, renders a `.cf-turnstile` div with the field's `sitekey`, and is skipped by the payload/validation loop — the token is picked up separately from the widget-injected `cf-turnstile-response` input.

## Two submit paths exist during the migration

`functions/api/submit/[site]/[slug].ts` reads its configuration from KV; `functions/api/submit.ts` still reads the global environment variables. Both are live on purpose — adding the KV path broke nothing, so the landing pages can be repointed one at a time, and the old route gets deleted once none of them use it.

**`site_key` sits in the path rather than the body, and that is forced by CORS.** A preflight `OPTIONS` carries no body, so a body-borne site key leaves you unable to decide which origin to allow at preflight time.

Configuration comes from two KV records, split so that the public endpoint never reads the one holding secrets:

| key | read by | holds |
| --- | --- | --- |
| `site:<site_key>` | the submit endpoint only | allowed origins, Turnstile **secret**, mail from/to, label |
| `form:<site_key>:<slug>` | `functions/api/form/[site]/[slug].ts`, returned verbatim | messages, fields, Turnstile **sitekey** (public), slug |

Both carry a `v`; an unrecognised version fails loudly rather than being interpreted under old assumptions. `SUPPORTED_SCHEMA_VERSION` in both functions pairs with `SiteProjection::SCHEMA_VERSION` in the console.

The KV-backed endpoint **validates every submitted value against the stored definition** and rejects keys the definition does not declare. That is the whole reason definitions moved off the landing pages: without a server-side definition, anyone past Turnstile could put arbitrary content into mail sent from a verified domain.

The definition endpoint is the highest-traffic path in the system — it is fetched per landing-page view, not per submission — so it is served with a cache header. Editing a form in the console takes up to that long to appear.

**`functions/api/submit.ts`** — the pre-migration Pages Function at `/api/submit` (file path = route). Handles OPTIONS preflight, rejects non-POST, verifies the Turnstile token against `challenges.cloudflare.com/turnstile/v0/siteverify`, then sends via SES. The email body is generated by serializing *every* posted key as `key: value` (minus `cf-turnstile-response`), so the form definition alone determines email contents — no server-side field schema to update when fields change. **The server does not validate or sanitize field values**; validation is client-side only.

`corsHeaders` must be spread onto every response path, including errors — a missing spread turns a real error into an opaque CORS failure in the browser.

**Typing of `functions/`** — `tsconfig.json` sets `"lib": ["ES2021"]` with `"types": ["@cloudflare/workers-types"]`, deliberately *without* `DOM`. Adding `DOM` back makes `document`/`localStorage`/`window` typecheck cleanly even though they crash in workerd, and it widens `Response.json()` to `any` (which is what previously left the Turnstile verify response unchecked). `"noEmit": true` is also deliberate: esbuild inside Wrangler does the bundling, and without it a bare `tsc` writes `submit.js` next to `submit.ts`, where it competes for the `/api/submit` route. `skipLibCheck` is load-bearing — the AWS SDK's type definitions reference `Buffer` and `node:stream`, and `@types/node` is not installed.

**`public/contact-form.css`** — all classes are `fp-`-prefixed to avoid collisions with host-page styles; keep that convention. Host pages link it themselves (the JS does not inject it).

UI strings and validation messages are Japanese.
