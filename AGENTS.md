# Agent Instructions

- After completing each task, commit the finished changes and push them before final response unless the user explicitly says not to or pushing is blocked.

## Native static hosting

Publish main through Cloudflare native Git builds, with credentials kept in
Cloudflare and previews off. Preserve the existing frontend, public paths and
Pages recovery. Use npm ci, npm run check:deploy and npm run test:hosting.
The large-file router must preserve canonical bytes, MIME, HEAD and Range behavior.
Generated chunks, mapping and Worker types stay ignored. Keep no-transform and
zone-only request metrics; do not introduce browser analytics.
