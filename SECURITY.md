# Security Policy

## Reporting a vulnerability

Please report security concerns privately to the project maintainer rather than
opening a public issue. Include the affected area, steps to reproduce, and any
relevant commit or branch. A response time has not been established yet.

## Security incident record

### Firebase web API key strings in historical service-worker files

During the Firebase-to-SQLite migration, Firebase web API key strings were
found in old service-worker files in Git history. The reachable repository
history was rewritten and force-pushed to remove the affected paths and key
strings. A subsequent scan of reachable commits found no Firebase config paths
or API-key-shaped strings. Git history cleanup cannot remove copies in old
clones, forks, caches, or other external archives.

No service-account private key was found in the history reviewed. Firebase
console access was unavailable during this cleanup, so key rotation, key
restrictions, account/rules review, and service-account audit remain pending.
Treat any exposed key as compromised until it has been revoked or rotated in
Google Cloud Console. History rewriting does not revoke a credential.

## Repository handling

- Keep `.env` and local credentials out of Git. Use `.env.example` only for
  non-secret defaults.
- Do not commit Firebase service-account credentials or private keys.
- Keep local SQLite databases (`*.db`, `*.sqlite`, and `*.sqlite3`) out of Git.
- The running app uses SQLite. Firebase is disconnected; setting
  `USE_FIREBASE=true` does not re-enable it. Re-enabling Firebase would require
  restoring or implementing an adapter and reviewing credentials and rules.
- If a credential is committed, revoke or rotate it first, then remove it from
  history and notify collaborators who may have cloned the affected commits.

## Demo hosting

SQLite data lives on the API host's filesystem. Free hosts with ephemeral
storage can lose database changes on restart or redeploy. Do not use this demo
setup for data that requires durable storage.
