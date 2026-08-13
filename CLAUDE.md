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

`wrangler.toml` is **gitignored** — copy `wrangler.toml.sample` to `wrangler.toml` and fill it in before running `npm run dev`. Required `[vars]`: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SES_FROM_ADDRESS`, `SES_TO_ADDRESS`, `TURNSTILE_SECRET_KEY`, `ALLOWED_ORIGINS`. Optional: `MAIL_SUBJECT_LABEL`, appended to the mail subject.

`ALLOWED_ORIGINS` is a comma-separated allowlist. Origins not on it get an empty `Access-Control-Allow-Origin`, so a cross-origin embed silently fails in the browser — add the LP's origin here (and `http://localhost:8788` for local testing). In production these are set as Pages environment variables/secrets, not in the committed file.

Note: earlier revisions read allowed origins and the Turnstile secret from a KV namespace. That was removed — everything now comes from `env`. Ignore leftover KV state in `.wrangler/`.

## Architecture

**`public/contact-form.js`** — a single IIFE, no build step, no dependencies. It reads its own `<script>` element via `document.currentScript`, so it must stay a classic synchronous script (not `type="module"`, not `async`/`defer`). Script attributes are the entire public API:

| attribute | meaning |
| --- | --- |
| `data-form-url` | URL of the JSON form definition (required) |
| `data-api-url` | submit endpoint; defaults to the script's own origin + `/api/submit` |

`data-api-url` defaults to the origin the script itself was served from, not a fixed URL. A hardcoded default sends submissions to whichever deployment that URL names, so anyone who deploys their own copy and forgets the attribute silently posts their visitors' messages to someone else's inbox.

`data-lp` is gone. It named the landing page and its value went into the mail subject, which let the sender choose part of the subject line. The subject label now comes from `MAIL_SUBJECT_LABEL` on the server. Host pages that still carry the attribute are unaffected; it is simply ignored.

It renders into `#contact-form` on the host page and does nothing if that element is absent.

**Form definition JSON** (see `public/test.json` for the canonical example) drives everything: `{ messages?, fields[] }`, or a bare array of fields. Each field has `name`, `label`, `type` (`text`/`email`/`textarea`/`select`/`radio`/`checkbox`/`turnstile` — anything else falls through to an `<input>` of that type), optional `required`, `options[]` for select/radio, and `validation` (`pattern`, `minLength`, `maxLength`, `message`). Adding a field type means touching `renderField()` and, if its value isn't read off `form.elements[name].value`, the submit handler and `validateField()` too.

A `turnstile` field is special-cased: it injects the Cloudflare Turnstile script, renders a `.cf-turnstile` div with the field's `sitekey`, and is skipped by the payload/validation loop — the token is picked up separately from the widget-injected `cf-turnstile-response` input.

**`functions/api/submit.ts`** — Cloudflare Pages Function at `/api/submit` (file path = route). Handles OPTIONS preflight, rejects non-POST, verifies the Turnstile token against `challenges.cloudflare.com/turnstile/v0/siteverify`, then sends via SES. The email body is generated by serializing *every* posted key as `key: value` (minus `cf-turnstile-response`), so the form definition alone determines email contents — no server-side field schema to update when fields change. **The server does not validate or sanitize field values**; validation is client-side only.

That is a narrower gap than it sounds. The recipient and the sender are both environment variables, so a submission cannot be redirected, and SESv2 builds the MIME itself, so a value cannot inject a header. What an unvalidated submission can do is put arbitrary text into a message delivered to your own inbox — which is also what typing into the form does. Server-side validation would buy data quality, not a security boundary. The bound that is actually missing is on volume: Turnstile is the only gate, and nothing limits how many times it can be cleared.

The whole handler is wrapped in `try`/`catch`. An uncaught throw never reaches a `return`, and Pages then answers with a bare 500 that carries no CORS headers and a stack trace in the body, which reaches the browser as an unexplained CORS failure. Error responses carry a generic message for the same reason the widget no longer displays them: the SES error text names addresses and AWS-side conditions.

`corsHeaders` must be spread onto every response path, including errors — a missing spread turns a real error into an opaque CORS failure in the browser.

**Typing of `functions/`** — `tsconfig.json` sets `"lib": ["ES2021"]` with `"types": ["@cloudflare/workers-types"]`, deliberately *without* `DOM`. Adding `DOM` back makes `document`/`localStorage`/`window` typecheck cleanly even though they crash in workerd, and it widens `Response.json()` to `any` (which is what previously left the Turnstile verify response unchecked). `"noEmit": true` is also deliberate: esbuild inside Wrangler does the bundling, and without it a bare `tsc` writes `submit.js` next to `submit.ts`, where it competes for the `/api/submit` route. `skipLibCheck` is load-bearing — the AWS SDK's type definitions reference `Buffer` and `node:stream`, and `@types/node` is not installed.

**`public/contact-form.css`** — all classes are `fp-`-prefixed to avoid collisions with host-page styles; keep that convention. Host pages link it themselves (the JS does not inject it).

UI strings and validation messages are Japanese.
