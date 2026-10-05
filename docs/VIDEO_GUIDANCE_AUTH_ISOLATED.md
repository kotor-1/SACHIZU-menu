# Video Guidance authentication — isolated integration

Better Auth 1.7.7 resolves database sessions through its bundled Prisma adapter
1.7.7 (`better-auth/adapters/prisma`). This retains the application's Prisma 6,
SQLite and Zod 3; Better Auth has its own nested Zod 4 dependency. Do not force a
root Zod upgrade or bypass peer dependency validation to install the adapter.

This integration is disabled unless `GUIDANCE_AUTH_ENABLED=1`. Enabling it also
requires `BETTER_AUTH_URL` and a private `BETTER_AUTH_SECRET` of at least 32
characters. Missing/invalid configuration fails closed. There is no default user,
secret or owner grant. The original development database has not been migrated.

The UI starts at `/video-guidance/sign-in`. `/api/auth/[...all]` delegates to
Better Auth's Next.js handler. Public sign-up is disabled; email/password is the
isolated localhost verification method, not a production sign-in decision.
Email delivery, OAuth, external identity services and AI APIs are not used.

## Identity and grants

`User`, `Session`, `Account`, `Verification` are authentication tables, separate
from `TrainingSession` and the resource `ownerId` namespace. `GuidanceOwnerAccess`
has a composite `(userId, ownerId, permission)` key and a cascading User relation.
No existing Exercise or historical reviewer is reassigned to a User.

Permissions are explicit and owner-specific:

| Permission | Operations |
| --- | --- |
| `VIEW_VIDEO_GUIDANCE` | Review index and detail |
| `REVIEW_VIDEO_GUIDANCE` | Hold, reject, modify and approve |
| `PUBLISH_VIDEO_GUIDANCE` | Publish an unapproved AI candidate |

Review does not imply Publish. A grant for one owner does not apply to another
owner. For a coach using the UI, grant View as well as the intended write
capability. Granting an authenticated user access is an operator decision; public
registration or first login never grants `default-coach` automatically.

`createVideoGuidanceIdentity()` resolves the session and grants on every call.
It passes the stable authenticated User ID into the existing identity port.
Page state, URL parameters, headers claiming an actor, and form reviewer fields
cannot supply identity. Cookie caching/session refresh on reads are disabled;
revoked, expired and deleted sessions are checked against the database.
The server repeats authorization at submit, then retains the existing source,
CAS, immutable revision, unresolved-field and operation-key checks.

Existing synthetic Phase 2 identities retain their trusted single-capability
semantics for compatibility. The actual session adapter always emits scoped
`ownerPermissions`, including an empty array when no grant exists.

## Local verification and migration safety

Run tests and migrations only in an isolated working copy/database. The current
test harness recreates `<cwd>/prisma/test.db`; do not run it in the original
workspace when preserving that database is required.

The additive migration `20261004000000_add_guidance_auth` creates five tables
and their indexes/FKs; it does not backfill users or change guidance/domain rows.
Test bootstrap uses an explicit isolated User and credential Account hashed by
`better-auth/crypto`. Session rows/cookies are issued by the real login handler,
not fabricated. No default test account is created by application startup.

The verification artifacts under
`reports/video-guidance-phase2-auth-isolated/` record migration up, exact existing
table comparisons, rollback of only the new five tables, and backup restoration.
Review actor IDs are historical strings, not cascading User references, so
removing authentication tables never silently deletes approval history.
There is no automatic production rollback command or production migration here.

Network checks block external traffic; browser verification permits loopback
only. Better Auth telemetry is disabled and inherited telemetry opt-in is
rejected before initialization. Origin/CSRF checks are explicitly enabled even
when `NODE_ENV=test` (the library otherwise defaults to skipping Origin checks
in tests). Do not put cookies, plaintext passwords or auth secrets in reports.

## Remaining boundaries

This authenticates the Video Guidance review surface, not unrelated legacy
application routes. Those routes still require a separate public-deployment
authorization decision. Production hosting, private evidence storage, auth
bootstrap/recovery operations and production cutover remain unresolved.
Composer/Interpreter/Running/Policy behavior and existing private guidance are
unchanged. Batch, canary, video analysis and production cutover remain disabled.

Official references checked for this implementation:

- [Next.js integration](https://better-auth.com/docs/integrations/next)
- [Prisma adapter](https://better-auth.com/docs/adapters/prisma)
- [Core database schema](https://better-auth.com/docs/concepts/database)
- [Email and password](https://better-auth.com/docs/authentication/email-password)
