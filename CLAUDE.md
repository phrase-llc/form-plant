# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

FormPlant is an embeddable contact-form widget for landing pages, hosted on Cloudflare Pages. A host page includes one `<script>` tag; the widget fetches a JSON form definition, renders the form client-side, and POSTs submissions to a Pages Function that verifies Cloudflare Turnstile and relays the message via AWS SES.

## Commands

```bash
npm install
npm run dev            # wrangler pages dev — serves ./public + ./functions at http://localhost:8788
npm test               # node --test — the submission-validation logic in functions/_lib/
npm run typecheck      # tsc — typecheck functions/ (no build step; Wrangler bundles TS directly)
npm run check:bundle   # build the Functions bundle and reject workerd-incompatible APIs
npm run check:client   # syntax-check public/contact-form.js and validate public/test.json
npm run seed:local     # write the local-dev site/form records into the preview KV namespace
npx wrangler pages deploy   # deploy
```

Local test page: `http://localhost:8788/test.html`. It fetches its definition from `/api/form/fp_localtest/contact` the way a real embed does, so **`npm run seed:local` is a prerequisite** — with an empty KV the page renders nothing but an error. The seed script builds both records from `public/test.json` and uses the Turnstile always-pass test pair (sitekey `1x00000000000000000000AA` in `test.json`, the matching test secret in the script).

There is no linter or formatter configured. Tests cover one thing — `functions/_lib/definition.ts`, the submission-validation boundary — because the other three checks are all incapable of noticing that logic regressing. Everything else is verified by a manual pass over the local test page. CI (`.github/workflows/ci.yml`) runs all four checks on every PR. Node version is pinned by `.node-version` (26.7.0, currently not an LTS line) and CI reads that file, so a version that cannot be installed fails the build.

The test runner is Node's built-in `node --test`, with no added dependency: Node strips the type annotations and runs the `.ts` files directly. `test/` is deliberately **outside** `tsconfig.json`'s `include` — typing the test file needs `@types/node`, and putting `node` in `types` would also let `process` and `Buffer` typecheck inside `functions/`, which is the same mistake as adding `DOM` back. The tests self-check by running, so they do not need the type net.

`check:bundle` exists because a dependency upgrade once shipped code that typechecked *and* bundled cleanly but died at runtime: the AWS SDK's browser-conditioned XML parser pulled in `DOMParser`, which workerd lacks. It scans the built bundle for such APIs and also fails on Wrangler's own `nodejs_compat` warning. See the header of `scripts/check-worker-bundle.mjs` before adding patterns — some obvious ones (`Buffer`, `window`) match guarded feature detection in the AWS SDK and will fail spuriously.

## Configuration

`wrangler.toml` is **gitignored** — copy `wrangler.toml.sample` to `wrangler.toml` and fill it in before running `npm run dev`. Required `[vars]`: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SES_FROM_ADDRESS`, `SES_TO_ADDRESS`, `TURNSTILE_SECRET_KEY`, `ALLOWED_ORIGINS`.

Also required: a `[[kv_namespaces]]` entry binding `CONFIG` (both `id` and `preview_id`). `wrangler pages dev` uses `preview_id`, which is why `npm run seed:local` passes `--preview`. Without this binding the two KV-backed functions throw on their first `env.CONFIG.get`.

`ALLOWED_ORIGINS` is a comma-separated allowlist for the pre-migration `/api/submit`; the KV path reads `allowed_origins` per site instead. Either way, **an origin allowlist is a browser-level control, not authorization.** Origins not on it get an empty `Access-Control-Allow-Origin`, so a cross-origin embed fails in the browser — but `Origin` is a request header that any non-browser client sets freely, so neither endpoint rejects a request for being off-list, and adding a 403 there would not change what an attacker can do. The only gate on submissions is Turnstile. There is no rate limiting yet.

In production these are set as Pages environment variables/secrets, not in the committed file.

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

**Form definition JSON** drives everything. `public/test.json` is the reference for the *field* part of a definition and is what `npm run seed:local` projects into KV; `v` and `slug` are not in it and must not be, because those are supplied by whatever writes the record (the console's `SiteProjection`, or the seed script, both of which strip them from the definition first). A definition served to the widget is `{ v, slug, messages?, fields[] }` — a bare array of fields is no longer accepted, since it has nowhere to carry `slug` and the widget cannot build a submit URL without it. Each field has `name`, `label`, `type` (`text`/`email`/`textarea`/`select`/`radio`/`checkbox`/`turnstile` — anything else falls through to an `<input>` of that type), optional `required`, `options[]` for select/radio, and `validation` (`pattern`, `minLength`, `maxLength`, `message`). Adding a field type means touching `renderField()` and, if its value isn't read off `form.elements[name].value`, the submit handler and `validateField()` too.

A `turnstile` field is special-cased: it injects the Cloudflare Turnstile script, renders a `.cf-turnstile` div with the field's `sitekey`, and is skipped by the payload/validation loop — the token is picked up separately from the widget-injected `cf-turnstile-response` input.

## Two submit paths exist during the migration

`functions/api/submit/[site]/[slug].ts` reads its configuration from KV; `functions/api/submit.ts` still reads the global environment variables. Both are live on purpose — adding the KV path broke nothing, so the landing pages can be repointed one at a time, and the old route gets deleted once none of them use it.

Repointing the landing pages does not by itself reduce anything. While `/api/submit` answers, one Turnstile token against the global `TURNSTILE_SECRET_KEY` still buys arbitrary mail content from the verified domain, and both routes send under the same SES identity, so the guarantees the KV path adds are only as good as the day the old route is deleted. It also means a site disabled in the console keeps working through the old route. Deleting it is the milestone, not the migration.

**`site_key` sits in the path rather than the body, and CORS forces that.** The reason is in the header comment of the submit function, where someone about to change the route shape will actually read it.

Code shared by the routes lives in `functions/_lib/`. `definition.ts` holds the KV contract — `SUPPORTED_SCHEMA_VERSION`, the field types, validation, and mail-body assembly — because a version constant duplicated per route produces the worst failure available here: bump one side and the definition endpoint serves the new schema while submissions 500. The `_` prefix does nothing for routing (verified: `functions/_lib/probe.ts` exporting `onRequest` *was* served at `/_lib/probe`); what keeps these files off the URL space is that they export no request handler, which makes Pages answer 404.

Configuration comes from two KV records, split so that the public endpoint never reads the one holding secrets:

| key | read by | holds |
| --- | --- | --- |
| `site:<site_key>` | the submit endpoint only | allowed origins, Turnstile **secret**, mail from/to, label |
| `form:<site_key>:<slug>` | `functions/api/form/[site]/[slug].ts` | messages, fields, Turnstile **sitekey** (public), slug |

The definition endpoint does **not** return the record verbatim. `PUBLIC_KEYS` in that file lists what gets served, and anything else in the record is dropped. Splitting the keys only helps if the read side also refuses to serve what it does not recognise; otherwise the guarantee rests on the console never writing a sensitive value into `form:`, and the day someone adds a notification address or an internal note there it goes public. The cost is that a genuinely new public key has to be added here too.

Both records carry a `v`; an unrecognised version fails loudly rather than being interpreted under old assumptions. `SUPPORTED_SCHEMA_VERSION` in both functions pairs with `SiteProjection::SCHEMA_VERSION` in the console. The submit endpoint checks `v` **before** it touches `allowed_origins`, so a record whose shape changed in a later version cannot be used for the CORS decision on the way to being rejected. That ordering also means the deploy order is one-way: form-plant has to learn a version before the console starts writing it.

The KV-backed endpoint **validates every submitted value against the stored definition** and rejects keys the definition does not declare. That is the whole reason definitions moved off the landing pages: without a server-side definition, anyone past Turnstile could put arbitrary content into mail sent from a verified domain.

Two things about `validation.pattern` are load-bearing, and both apply to `validateField()` in the widget as well as the server:

- **A pattern that can backtrack catastrophically is rejected before it ever runs** (`unsafePattern()`). A regex from the definition runs on attacker-supplied input, and a quantifier applied to a group that already contains one costs exponential time in the input length. This is not a hypothetical written by a hostile tenant: `^(\d+)+$` matches a real phone number instantly and only blows up on long input that *fails* to match, so a plausible-looking pattern behaves fine until a visitor mistypes. Measured: a 35-character value against that pattern burned 72 seconds of CPU in the Function, and 96 seconds in plain Node. In the browser there is no CPU limit at all — the visitor's tab simply freezes, which is why the same check is duplicated in `contact-form.js` (no build step there, so it cannot be imported; fixing one side only leaves the other freezing). **Length limits do not help here and must not be mistaken for a mitigation** — growth is exponential, so any cap is already past the cliff. `MAX_FIELD_LENGTH` exists to bound the mail body, nothing more. The check is a detector, not a decision procedure: it catches the nested-quantifier family and misses alternation overlap like `(a|a)*`. The sound fix is to stop accepting arbitrary regexes and offer named formats instead, which is a console-side change.
- **Length is still checked before the pattern.** Cheap checks first, and a `maxLength` violation stops there rather than accumulating a second message.
- **Patterns are compiled as `^(?:...)$`.** Unanchored, `test()` is a substring match, so `\d{10,11}` would accept 200 characters of anything containing a phone number. Wrapping matches the semantics of the HTML `pattern` attribute, which is where these regexes get copied from. Already-anchored patterns survive the wrapping.

A pattern that fails to compile is a server-configuration fault, not a submission fault, so it returns 500 instead of telling the visitor their input is malformed — they cannot fix it, and a 422 would hide the breakage from whoever wrote the definition.

The definition endpoint is the highest-traffic path in the system — it is fetched per landing-page view, not per submission — so it is served with a cache header. Editing a form in the console takes up to that long to appear.

**`functions/api/submit.ts`** — the pre-migration Pages Function at `/api/submit` (file path = route). Handles OPTIONS preflight, rejects non-POST, verifies the Turnstile token against `challenges.cloudflare.com/turnstile/v0/siteverify`, then sends via SES. The email body is generated by serializing *every* posted key as `key: value` (minus `cf-turnstile-response`), so the form definition alone determines email contents — no server-side field schema to update when fields change. **The server does not validate or sanitize field values**; validation is client-side only.

`corsHeaders` must be spread onto every response path, including errors — a missing spread turns a real error into an opaque CORS failure in the browser. Spreading it on every `return` is not sufficient by itself: an uncaught throw never reaches a `return`, and Pages then answers with a bare 500 carrying no CORS headers and a stack trace in the body. Both KV-backed functions wrap their whole handler in `try`/`catch` for that reason, and the submit endpoint validates the shape of what it read from KV (`Array.isArray` on `allowed_origins`, `forms`, and `fields`) rather than trusting the console. A string `allowed_origins` is the reason the array check is not merely defensive: `String.prototype.includes` would happily match a substring of it and allow origins nobody listed.

Error responses carry a generic message. The SES error text names addresses and AWS-side conditions, and the widget puts the server's `error` string on the page, so the detail goes to `console.error` only. The widget reinforces this from its side: it displays the server's text only for 422, where the message came from the stored definition.

**Typing of `functions/`** — `tsconfig.json` sets `"lib": ["ES2021"]` with `"types": ["@cloudflare/workers-types"]`, deliberately *without* `DOM`. Adding `DOM` back makes `document`/`localStorage`/`window` typecheck cleanly even though they crash in workerd, and it widens `Response.json()` to `any` (which is what previously left the Turnstile verify response unchecked). `"noEmit": true` is also deliberate: esbuild inside Wrangler does the bundling, and without it a bare `tsc` writes `submit.js` next to `submit.ts`, where it competes for the `/api/submit` route. `skipLibCheck` is load-bearing — the AWS SDK's type definitions reference `Buffer` and `node:stream`, and `@types/node` is not installed.

**`public/contact-form.css`** — all classes are `fp-`-prefixed to avoid collisions with host-page styles; keep that convention. Host pages link it themselves (the JS does not inject it).

UI strings and validation messages are Japanese.
