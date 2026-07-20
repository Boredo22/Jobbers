# ai-queue — Cowork provider (Mode C) work queue

This folder is how Jobber's **`CoworkProvider`** (AI Mode C) gets model output with
**no API key and no CLI** — a Claude *Cowork* session does the work by exchanging
files here.

```
apps/api  ──writes──▶  ai-queue/pending/<id>.json    (a request)
Cowork session ──reads pending, answers──▶  ai-queue/done/<id>.json   (the result)
apps/api  ──reads done, validates, deletes both──▶  returns the answer to its caller
```

`pending/` and `done/` are gitignored (they hold transient, possibly personal job
data). Only this README is committed.

## If you are the Cowork session, do this

You have this folder connected. **Process every file in `pending/`:**

1. Read `pending/<id>.json`. Its shape:
   ```json
   {
     "id": "<uuid>",
     "schemaName": "fit_score",         // or resume_review, ideal_job_profile, tailored_draft
     "prompt": "<the full prompt — already includes the JSON Schema to satisfy>",
     "jsonSchema": { /* the exact schema the answer must match */ },
     "meta": { "tier": "small", "maxTokens": 1024 }
   }
   ```
2. Do what the `prompt` asks. Produce a result that **strictly matches
   `jsonSchema`** — right fields, right types, arrays are arrays, nothing extra.
3. Write the answer to `done/<id>.json` (same `id` as the request):
   ```json
   {
     "id": "<same uuid>",
     "result": { /* the object matching jsonSchema */ },
     "model": "<the model you used>",      // optional, for the cost ledger
     "usage": { "input_tokens": 0, "output_tokens": 0 }  // optional, best effort
   }
   ```
   `result` should be the JSON **object** itself (a JSON string is tolerated but
   an object is preferred).
4. Do **not** delete files — the API deletes both `pending/` and `done/` once it
   ingests the answer. Just leave your `done/<id>.json` behind.

Process **all** pending requests, then stop. The API validates every answer with
the same Zod schema; if it doesn't match, it re-asks (a fresh `pending/` file with
the validation errors appended), so getting the shape right first time saves a round.
