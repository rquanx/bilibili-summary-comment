# Local reader preview

Start from the repository root:

```powershell
node --import tsx deploy/privatebin/reader-preview/server.ts
```

Open http://127.0.0.1:4318/. The server binds only to localhost. No packages, Docker images, fonts, or remote assets are downloaded. No production service, Railway config, or pipeline environment is changed.

This is a reading-interface prototype, not a local deployment of the complete PHP application. It serves a local sample encrypted by the pipeline's existing PrivateBin v2 uploader with a mocked HTTP transport. The browser actually decrypts it using Web Crypto. Only the encrypted payload is returned by `/api/paste`; the key lives in the URL fragment. A new sample key is generated each time the server starts; enter through `/` after restarting.

When available, the sample text is read from the existing local `paste-p02.txt` for BV1CvWg6aEEh. Otherwise it uses short demo text. The document title, part, source/date and expiry labels are demo presentation values. They will need actual paste metadata integration before production use.

Implemented: responsive text layout, timestamp columns, adjustable font size, light/dark toggle, plain text typography toggle, clipboard copy, scroll progress, reduced-motion handling. Reading text is rendered via `textContent`.

Scope: read-only preview, no upload form, no production paste fetching, no password/attachment/discussion/burn-after-reading handling. The preview supports the pipeline's uncompressed v2 encrypted sample. A production integration must preserve PrivateBin's existing crypto, expiry, password and burn-after-reading behavior rather than replace it with this sample server.

Verified in Chrome at desktop and 390 px mobile width: successful decryption, theme and text mode switching, copying full text.
