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
npm run check:client   # syntax-check public/contact-form.js and validate public/forms/contact.json
npx wrangler pages deploy   # deploy
```

Local test page: `http://localhost:8788/test.html`. `npm run dev` is the only prerequisite — there is no store to populate. It embeds the widget exactly the way a host page does, pointing at `/forms/contact.json`, and uses the Turnstile always-pass test pair (sitekey `1x00000000000000000000AA` in the definition, the matching test secret in `wrangler.toml`).

There is no linter or formatter configured. Tests cover one thing — `functions/_lib/definition.ts`, the submission-validation boundary — because the other three checks are all incapable of noticing that logic regressing. Everything else is verified by a manual pass over the local test page. CI (`.github/workflows/ci.yml`) runs all four checks on every PR. Node version is pinned by `.node-version` (26.7.0, currently not an LTS line) and CI reads that file, so a version that cannot be installed fails the build.

The test runner is Node's built-in `node --test`, with no added dependency: Node strips the type annotations and runs the `.ts` files directly. `test/` is deliberately **outside** `tsconfig.json`'s `include` — typing the test file needs `@types/node`, and putting `node` in `types` would also let `process` and `Buffer` typecheck inside `functions/`, which is the same mistake as adding `DOM` back. The tests self-check by running, so they do not need the type net.

`check:bundle` exists because a dependency upgrade once shipped code that typechecked *and* bundled cleanly but died at runtime: the AWS SDK's browser-conditioned XML parser pulled in `DOMParser`, which workerd lacks. It scans the built bundle for such APIs and also fails on Wrangler's own `nodejs_compat` warning. See the header of `scripts/check-worker-bundle.mjs` before adding patterns — some obvious ones (`Buffer`, `window`) match guarded feature detection in the AWS SDK and will fail spuriously.

## Configuration

`wrangler.toml` is **gitignored** — copy `wrangler.toml.sample` to `wrangler.toml` and fill it in before running `npm run dev`. Required `[vars]`: `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `SES_FROM_ADDRESS`, `SES_TO_ADDRESS`, `TURNSTILE_SECRET_KEY`, `ALLOWED_ORIGINS`.

There is no datastore to configure. One deployment serves one site: its secrets are environment variables, and its form definitions are files in the repo. Two sites means two Pages projects, which is simpler than any scheme for holding several sites' configuration in one deployment.

`ALLOWED_ORIGINS` is a comma-separated allowlist. **An origin allowlist is a browser-level control, not authorization.** Origins not on it get an empty `Access-Control-Allow-Origin`, so a cross-origin embed fails in the browser — but `Origin` is a request header that any non-browser client sets freely, so neither endpoint rejects a request for being off-list, and adding a 403 there would not change what an attacker can do. The only gate on submissions is Turnstile. There is no rate limiting yet.

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

**Form definition JSON** drives everything, and this is the centre of the design: drop a JSON file in `public/forms/`, deploy, and you have a working, server-validated form. A definition is `{ slug, label?, messages?, fields[] }`. `slug` is what the widget uses to build the submit URL and what the route matches on. `label` goes into the mail subject. A bare array of fields is not accepted — it has nowhere to carry `slug`. Each field has `name`, `label`, `type` (`text`/`email`/`textarea`/`select`/`radio`/`checkbox`/`turnstile` — anything else falls through to an `<input>` of that type), optional `required`, `options[]` for select/radio, and `validation` (`pattern`, `minLength`, `maxLength`, `message`). Adding a field type means touching `renderField()` and, if its value isn't read off `form.elements[name].value`, the submit handler and `validateField()` too.

A `turnstile` field is special-cased: it injects the Cloudflare Turnstile script, renders a `.cf-turnstile` div with the field's `sitekey`, and is skipped by the payload/validation loop — the token is picked up separately from the widget-injected `cf-turnstile-response` input.

## Two submit paths exist during the migration

`functions/api/submit/[slug].ts` validates the submission against the stored definition; `functions/api/submit.ts` does not. Both read the same environment variables, and both are live on purpose — adding the validating route broke nothing, so the landing pages can be repointed one at a time, and the old route gets deleted once none of them use it.

Repointing the landing pages does not by itself reduce anything. While `/api/submit` answers, one Turnstile token still buys arbitrary mail content from the verified domain, and both routes send under the same SES identity, so the guarantee the new route adds is only as good as the day the old route is deleted. Deleting it is the milestone, not the migration.

**The definition is a build-time input, not runtime state.** `functions/_lib/forms.ts` imports each `public/forms/*.json` and Wrangler bundles it into the Function; the same file is served statically to the widget. One file, two consumers, and they cannot drift apart because they ship in the same deployment. Three things follow:

- **There is no schema version.** A version number exists to catch a writer and a reader disagreeing; here they are the same artifact.
- **There are no runtime shape checks on the definition.** `tsc` verifies each JSON against `FormDefinition`, so a malformed definition fails `npm run typecheck` rather than turning into a 500. This is why `forms.ts` lists its imports explicitly instead of scanning a directory — a directory scan would be untyped and would hide what actually got bundled.
- **A definition cannot be changed without a deploy.** That is a stronger guarantee than a datastore offers, and it is the property that makes server-side validation worth anything.

Adding a form means adding `public/forms/<slug>.json` and one line in `forms.ts`.

Code shared by the routes lives in `functions/_lib/`. The `_` prefix does nothing for routing (verified: `functions/_lib/probe.ts` exporting `onRequest` *was* served at `/_lib/probe`); what keeps these files off the URL space is that they export no request handler, which makes Pages answer 404.

The new route **validates every submitted value against the definition** and rejects keys the definition does not declare. Without that, anyone past Turnstile could put arbitrary content into mail sent from a verified domain — which is exactly what the old route still allows.

**`validation.pattern` is compiled as `^(?:...)$`,** both here and in the widget's `validateField()`. Unanchored, `test()` is a substring match, so `\d{10,11}` would accept 200 characters of anything containing a phone number. Wrapping matches the semantics of the HTML `pattern` attribute, which is where these regexes get copied from. Already-anchored patterns survive the wrapping. Length is checked before the pattern — cheap checks first, and a `maxLength` violation stops there rather than accumulating a second message.

A pattern that fails to compile is a configuration fault, not a submission fault, so it returns 500 instead of telling the visitor their input is malformed — they cannot fix it, and a 422 would hide the breakage from whoever wrote the definition.

**Whether a pattern can backtrack catastrophically is not checked at request time, and that is deliberate.** The danger is real: a quantifier applied to a group that already contains one costs exponential time in the input length, and the regex runs on visitor-supplied input. Measured, `^(\d+)+$` against a 35-character value burned 72 seconds of CPU in the Function, and in the browser, where there is no CPU limit, it freezes the tab outright. Nor does it take malice — that pattern matches a real phone number instantly and only blows up on long input that *fails* to match, so it behaves perfectly until a visitor mistypes.

The check still belongs where the pattern is written, which for this repo is review of the JSON before it is committed. Rejecting at request time tells the wrong person: the visitor gets a 500 and whoever wrote the pattern learns nothing. Length limits are not a mitigation for any of this and must not be mistaken for one; `MAX_FIELD_LENGTH` bounds the mail body, nothing more.

**`functions/api/submit.ts`** — the pre-migration Pages Function at `/api/submit` (file path = route). Handles OPTIONS preflight, rejects non-POST, verifies the Turnstile token against `challenges.cloudflare.com/turnstile/v0/siteverify`, then sends via SES. The email body is generated by serializing *every* posted key as `key: value` (minus `cf-turnstile-response`), so the form definition alone determines email contents — no server-side field schema to update when fields change. **The server does not validate or sanitize field values**; validation is client-side only.

`corsHeaders` must be spread onto every response path, including errors — a missing spread turns a real error into an opaque CORS failure in the browser. Spreading it on every `return` is not sufficient by itself: an uncaught throw never reaches a `return`, and Pages then answers with a bare 500 carrying no CORS headers and a stack trace in the body. `functions/api/submit/[slug].ts` wraps its whole handler in `try`/`catch` for that reason, which also covers the SES call.

Error responses carry a generic message. The SES error text names addresses and AWS-side conditions, and the widget puts the server's `error` string on the page, so the detail goes to `console.error` only. The widget reinforces this from its side: it displays the server's text only for 422, where the message came from the definition.

**Typing of `functions/`** — `tsconfig.json` sets `"lib": ["ES2021"]` with `"types": ["@cloudflare/workers-types"]`, deliberately *without* `DOM`. Adding `DOM` back makes `document`/`localStorage`/`window` typecheck cleanly even though they crash in workerd, and it widens `Response.json()` to `any` (which is what previously left the Turnstile verify response unchecked). `"noEmit": true` is also deliberate: esbuild inside Wrangler does the bundling, and without it a bare `tsc` writes `submit.js` next to `submit.ts`, where it competes for the `/api/submit` route. `skipLibCheck` is load-bearing — the AWS SDK's type definitions reference `Buffer` and `node:stream`, and `@types/node` is not installed.

**`public/contact-form.css`** — all classes are `fp-`-prefixed to avoid collisions with host-page styles; keep that convention. Host pages link it themselves (the JS does not inject it).

UI strings and validation messages are Japanese.
