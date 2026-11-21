# Attachments: photos and documents

Code: `src/core/attach.ts` (limits, readers, `process_`, `expand`), `src/server/api.ts` (`uploadGet`), `src/server/chat.ts`, `src/core/tools.ts` (`read_file`), `src/ui/composer.tsx` + `src/ui/lib/api.ts` (page side: shrink, base64, limits), `src/ui/lib/turn.ts` (`parseUserContent`).
Tests: `src/core/attach.test.ts`, `src/server/api.test.ts` (attachment API), `src/ui/lib/turn.test.ts`.
Signed-in users only. Visitors have no attachments (the public chat stays text-only); the admin `/task` endpoint refuses them too.

## What a user can do
- Paperclip button, paste (images) or drag and drop (desktop). Up to 4 attachments per message: one photo plus documents.
- **Photo** (needs the `vision` setting, see below): the page shrinks it to at most 1280 px on the long side and re-encodes it as JPEG (rotation fixed, transparency flattened), so a phone photo is about 100-300 KB. The server accepts up to 2.5 MB and checks the file's real type from its first bytes (jpeg, png, gif, webp), not from its name.
- **Documents**: `.txt .md .csv .tsv .json .xml .yaml .yml .toml .ini .log .html .css .js .ts .py .sh .sql .c .h .cpp .java .go .rs .rb .php` (UTF-8 text), `.docx` (unzipped with `fflate`, paragraph text only) and `.pdf` (text layer via poppler's `pdftotext`). Up to 3 MB each. The list is `attach.ts` `READERS` (extension -> reader function); a new type is a new row, and `/api/me` tells the page which extensions to accept.
- A message may be only attachments; the text then defaults to "Please look at the attached file."

## What the model gets
- Documents: their text is appended to the user's message inside `<attached_file name="...">...</attached_file>` (the closing tag inside a document is removed, so it can't end its own wrapper). At most 12,000 characters per document and 24,000 per message; longer ones say `truncated: N of M characters` and where the whole file is.
- Every original is saved in the session's own folder, `uploads/<name>`, so `read_file` can open it. `read_file` also reads `.pdf` and `.docx` as text, line by line, so a long document can be paged through (`error[unreadable]` for a scan or a broken file).
- Photo: stored as `uploads/<name>.<jpg|png|...>`; the message in the database holds only `{"type":"image_ref","name":...}`. When the model is called, `attach.expand` turns the reference into an `image_url` data URL on the **newest message that has a photo** (so a follow-up question still sees it); older photos become `[an earlier photo is not shown]`. The size estimate used for compaction counts the small stored form.
- Things the user attached are the user's own data, but a document can still carry third-party instructions: the model is not told to trust them more than other text.

## Errors (all `bad_request`, shown as a plain message, nothing is created)
Too many files, invalid base64, unsupported type (lists what is supported), photo while `vision` is off, second photo, photo or document too large, text file that is really binary, PDF with no text layer (scan, no OCR), PDF reading not installed, unreadable `.docx`/`.pdf`. Validation runs before a session or stream exists, so the page gets a normal HTTP 400.
Request bodies: signed-in chat accepts up to 9 MB (`ATTACH_BODY`), everything else 1 MB. A refused body is read (up to 20 MB) before the 400 is sent, otherwise the browser would see a connection reset instead of the message.

## Serving them back
- `GET /api/sessions/<id>/uploads/<name>` (owner only; the name is `\w[\w.-]{0,99}`, no slashes). Photos are shown inline in the saved chat; everything else downloads (`Content-Disposition: attachment`, `application/octet-stream`). All carry `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`, so an uploaded HTML or SVG file can't run in our origin.
- Another user's session or file is a plain 404. Files live in `<workspace>/users/<uid>/<session id>/uploads/` and go away with `DELETE /api/sessions/<id>`.

## The `vision` setting (off by default)
- Settings row `vision` (type `bool`, dashboard-editable). While off, photos are refused and the page hides nothing else. Turn it on only when the model behind `BASE_URL` can look at images (a vision-language model). **I could not check this for the current model** (`qwen/qwen3.6-35b-a3b` on lyna): the node is on your LAN behind a key, so test with one photo after enabling, and keep it off if the answers are nonsense or the backend errors (that shows as an `upstream_4xx` error card).
- `bool` is a new settings field type; `/manage/manifest` reports it as `"type":"bool"`, which the node-agent contract already lists.

## Deploy
- The `Dockerfile` installs `poppler-utils` (about 4 MB); without it PDFs answer "reading PDFs isn't set up on this server" and everything else still works. **Not run here**: no Docker, and `pdftotext` is not installed on this Mac, so **the PDF reader has no test at all** in the TypeScript app (the Python one was tested against a mocked `subprocess.run`; that test was not ported). Try one real PDF after deploying.

## Not done
- No OCR (scanned PDFs, text in photos is only what the vision model reads).
- No spreadsheet (`.xlsx`) or slide (`.pptx`) readers; `.docx` keeps no tables structure or images.
- Photos are not available to helper agents (`delegate`) or automations.
- No quota on total upload storage per user.
