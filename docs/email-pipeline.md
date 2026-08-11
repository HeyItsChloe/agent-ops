# Shared email pipeline (Epic 6)

A provider-agnostic email sender in the agent-ops orchestrator. Any repo in
the fleet sends mail through one contract and one endpoint; the orchestrator
picks the delivery backend (Gmail or Mailchimp) and hides its internals. A
caller only chooses `provider` and the fields it wants — it never touches
Gmail MIME/OAuth or Mandrill envelopes.

Code lives under `orchestrator/src/integrations/email/`:

| File | Role |
| --- | --- |
| `types.ts` | The shared request contract (`emailRequestSchema` + `EmailRequest`) and `EmailResult`. |
| `gmail.ts` | Gmail provider — OAuth refresh-token grant + Gmail REST send, plain `fetch`. |
| `mailchimp.ts` | Mailchimp provider — Mailchimp Transactional (Mandrill), plain `fetch`. |
| `index.ts` | `sendEmail(req)` — validates the contract, routes to the provider. |
| `route.ts` | `mountEmailRoutes(app, secret)` — exposes `POST /email`. |

## The contract

```jsonc
{
  "provider": "gmail" | "mailchimp",   // required
  "to": "a@x.com" | ["a@x.com", ...],  // required, one or many
  "cc":  "…" | ["…"],                   // optional
  "bcc": "…" | ["…"],                   // optional
  "subject": "…",                       // string, optional*
  "text": "…",                          // plain-text body, optional*
  "html": "…",                          // HTML body, optional*
  "template": "welcome-email",          // Mailchimp template name, optional
  "templateVars": { "FNAME": "Chloe" }  // Mailchimp merge vars, optional
}
```

Validation rules (enforced by `emailRequestSchema`, applied on every path in):

- **At least one recipient** — `to` must be a non-empty address (or array).
- **Gmail requires `subject` and at least one of `text`/`html`.**
- **`template` / `templateVars` are valid only for `mailchimp`** (Gmail has no
  template concept and rejects them).
- Mailchimp needs *something to send*: a `template` or inline `text`/`html`.

### Result shape (`EmailResult`)

```jsonc
{
  "ok": true,
  "provider": "gmail",
  "id": "18f...",            // provider message id (Gmail id / Mandrill _id)
  "accepted": ["a@x.com"],   // addresses the provider accepted
  "rejected": [],            // addresses the provider refused
  "error": "…"               // present only when ok=false; always secret-free
}
```

## Providers

### Gmail (tickets #43, #45)

Uses the Gmail API with an OAuth refresh-token grant — **no password auth**,
and no `googleapis` dependency. On each send it exchanges the refresh token for
a short-lived access token at `https://oauth2.googleapis.com/token`, then POSTs
a base64url-encoded RFC-2822 MIME message to
`https://gmail.googleapis.com/gmail/v1/users/me/messages/send`. Supports one or
many recipients, `subject`, plain text, HTML, and `multipart/alternative` when
both `text` and `html` are given. `From:` is `GMAIL_SENDER`.

### Mailchimp (ticket #46)

Uses **Mailchimp Transactional (Mandrill)**. Direct content posts to
`messages/send.json`; a named template posts to `messages/send-template.json`
with `template_name`, an (empty) `template_content`, and `global_merge_vars`
derived from `templateVars`. Supports one or many recipients. `From:` is
`MAILCHIMP_FROM_EMAIL` (required for a direct send; a template may use its own
configured default sender).

## Required GitHub Secrets

| Secret | Provider | Purpose |
| --- | --- | --- |
| `GMAIL_CLIENT_ID` | Gmail | OAuth client id |
| `GMAIL_CLIENT_SECRET` | Gmail | OAuth client secret |
| `GMAIL_REFRESH_TOKEN` | Gmail | Long-lived refresh token |
| `GMAIL_SENDER` | Gmail | `From:` mailbox address |
| `MAILCHIMP_TRANSACTIONAL_API_KEY` | Mailchimp | Mandrill API key |
| `MAILCHIMP_FROM_EMAIL` | Mailchimp | `From:` address (optional for template sends) |

Wiring these into the deployed service (Cloud Run env / workflow) is **ticket
#20 follow-up** — see below. `deploy-orchestrator.yml` is intentionally left
untouched here.

## REST usage — `POST /email` (ticket #19)

Guarded by the same shared-secret middleware as the rest of the orchestrator:
send the `x-orchestrator-secret` header (`ORCHESTRATOR_SHARED_SECRET`).

- `200` — sent; body is the `EmailResult`.
- `400` — validation failure (bad/missing fields, or too many recipients).
- `401` — missing/incorrect shared secret.
- `502` — provider failed to deliver; body is a not-ok `EmailResult`.

```bash
curl -sS -X POST https://<orchestrator-host>/email \
  -H "x-orchestrator-secret: $ORCHESTRATOR_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
        "provider": "gmail",
        "to": "recipient@example.com",
        "subject": "Hello from the pipeline",
        "text": "Plain-text body.",
        "html": "<p>HTML body.</p>"
      }'
```

Mailchimp template example:

```bash
curl -sS -X POST https://<orchestrator-host>/email \
  -H "x-orchestrator-secret: $ORCHESTRATOR_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
        "provider": "mailchimp",
        "to": ["a@example.com", "b@example.com"],
        "subject": "Welcome",
        "template": "welcome-email",
        "templateVars": { "FNAME": "Chloe" }
      }'
```

## Security guardrails (ticket #21, partial)

- **Shared-secret auth** — reuses the existing `sharedSecretAuth` middleware
  (`x-orchestrator-secret`), no new scheme.
- **Recipient cap** — a request with more than `MAX_TOTAL_RECIPIENTS` (50)
  combined `to`+`cc`+`bcc` addresses is rejected `400`, bounding blast radius.
- **No secret echo** — validation errors report input field paths only;
  provider error messages are pre-scrubbed (they describe the request/fault,
  never the credential values); unexpected faults return a generic `502` with
  detail logged server-side only.
- **No password auth** — Gmail is OAuth-only.

## Follow-up (NOT built here)

- **Ticket #20** — reusable GitHub Action / workflow for other repos to call
  `POST /email`, plus wiring the secrets above into the deployed service.
- **Ticket #21 (full)** — complete security/audit hardening: rate limiting,
  send auditing, per-caller scoping, allow/deny sender lists.
- **Tickets #22–#24** — BusyBuddy / OrderMate integration onto this pipeline.
