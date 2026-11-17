# Railway summary paste service

> RETIRED on 2026-11-14. The live MicroBin service and DNS records were removed at the user's request. Do not deploy this folder or the `video-pipeline:gpu-microbin-ready` candidate. The replacement is documented in [PrivateBin deployment](../privatebin/README.md). The historical configuration below is retained only for reference.

Selected: [MicroBin](https://github.com/szabodanika/microbin), approximately 4.6k stars checked on 2026-11-14. PrivateBin has approximately 8.7k stars but its browser encryption protocol requires a more complex pipeline integration.

Deploy this folder as the upload root of a **new Railway project** named `summary-paste`, with one service named `microbin`. Do not upload the video-pipeline repository root or its `.env`, `.auth` or `work` directories.

- Add a persistent volume at `/app/microbin_data`. Railway provisioned a 5 GB maximum; its volume settings state that charges apply to data actually stored.
- Set `MICROBIN_UPLOADER_PASSWORD` and `MICROBIN_ADMIN_PASSWORD` to different random secrets. Never commit them.
- Use `microbin.tool.voxwing.top` as the custom Railway domain targeting port 8080; set `MICROBIN_PUBLIC_PATH=https://microbin.tool.voxwing.top`. Add only the DNS and verification records Railway requests in the Cloudflare `voxwing.top` zone. Start with DNS-only records until Railway TLS is verified. A three-level hostname may need additional Cloudflare edge-certificate coverage before proxying, so do not enable the proxy by default.
- Keep one replica. JSON storage and the persistent volume are not designed for multiple replicas.
- The Dockerfile uses the official MicroBin 2.1.4 amd64 image pinned by digest. Deployment downloads that image once, with no apt/npm/pip updates or Rust compilation. This is a new service, so it has no existing build cache. Railway charges for runtime resources, storage and network usage.

JSON storage deliberately avoids the known MicroBin 2.1.4 SQLite column-order issue that can prevent old pastes loading after restart (upstream issue #358). The startup script runs in the volume and maps the JSON backend's hardcoded `pasta_data` path into that same volume. This is suitable for this small summary store; resource use should be reviewed as the archive grows. Back up the volume regularly.

New pastes are unlisted, readable without a password, immutable to public readers, never expire and are excluded from idle garbage collection. Uploads require a password. Paste IDs are guessable; this service is for public video summaries, not secrets.

## Pipeline integration

After verifying the service, add these variables to the video-pipeline environment:

```dotenv
MICROBIN_URL=https://microbin.tool.voxwing.top
MICROBIN_UPLOADER_PASSWORD=THE-SAME-UPLOAD-PASSWORD
```

The upload adapter sends multipart `content`, `privacy=unlisted`, `expiration=never`, `burn_after=0` and the upload password to `/upload`. It accepts only a 302 redirect to `/upload/{id}` on the same origin, then publishes `/raw/{id}`. Wrong-password redirects are errors. Requests time out after 30 seconds; failures retain bounded, redacted response details. Existing paste.rs summaries remain recognizable. Historical reason codes and shared upload rate-limit filenames are retained for compatibility.

Before switching the scheduler: upload Chinese test text, confirm unauthenticated raw retrieval exactly matches, check wrong-password uploads fail, restart the service and verify the text survives, then remove only the test paste with the admin password. Volume restart tests briefly interrupt only this new service.

## Deployment record (2026-11-14)

- Project: `summary-paste` (`66f48039-c31f-4cfd-92c9-993d85ff2d04`); production environment: `8772c5e3-983c-471a-ae81-c22cd8152f3b`.
- Service: `microbin` (`62a3524e-2692-4c77-978f-d132c0be0b8c`); volume: `1b902c24-e65d-4f2f-aa9b-f7db23277e3c`.
- Public origin: `https://microbin.tool.voxwing.top`; DNS-only CNAME: `microbin.tool` to `dxrho69f.up.railway.app`. Railway ownership TXT is installed at `_railway-verify.microbin.tool`.
- Separate random credentials are stored in Railway variables and the ignored local `.auth/microbin-railway.json`, restricted to the current Windows user and SYSTEM.
- Verified Chinese text upload, public raw retrieval, invalid upload password rejection, preservation across service restart, and admin removal of the test paste (raw endpoint returned 404 afterward). Multipart text line endings normalize to CRLF; Chinese text is preserved.
- Health check `/` (60 seconds) and five failure restarts are configured directly through the Railway API. This avoids depending on the deprecated `railway.json` format.
- Pipeline image `video-pipeline:gpu-microbin-ready` is prepared offline. The existing running GPU service and pipeline `.env` have not been switched; Bilibili publication behavior with this domain remains unverified.

Rebuild the GPU pipeline using `Dockerfile.gpu.incremental` with the existing local image and `--pull=false --network=none`, following the repository AGENTS.md. Switching the scheduler resumes automatic processing of pending comments; it may publish public summary links to Bilibili. Obtain approval for that production change before deployment. Do not delete existing comments or reset published states as part of this migration.
