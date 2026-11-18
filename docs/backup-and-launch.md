# Backup, recovery and launch readiness

## Encrypted export
Admin → Access → Encrypted backup. Enter a new high-entropy passphrase (at least 20 characters), repeat it and reauthenticate. The server reads the persisted state, encrypts it with scrypt and AES-256-GCM, and returns only the encrypted envelope. Keep the passphrase separately. The export includes business records and salted credential hashes, potentially personal data, not environment variables or API keys. There is no background backup and no public restore endpoint.

Offline recovery on a trusted computer with the repository and Node.js:
```bash
read -rs -p 'Backup passphrase: ' FD_BACKUP_PHRASE; echo
printf '%s' "$FD_BACKUP_PHRASE" | node scripts/decrypt-backup.js backup.encrypted.json recovered-state.json
unset FD_BACKUP_PHRASE
```
The tool refuses to overwrite an existing output. The decrypted file is sensitive. Do not commit, upload to a public folder, paste into chat, or point it at the current running database. Verify the file and test restore in an isolated environment before a planned migration. Rotate credentials if any compromise is suspected. Store encrypted backups in separate locations, with retention and access controls. Do not retain them indefinitely.

## Database continuity
The existing Render free PostgreSQL instance has a finite expiry. Confirm the exact expiry in the dashboard; it was 2026-12-16 when checked. An exported backup does not keep the live database available after expiry. Before expiry, choose a durable destination and confirm costs, limits, processor terms and processing region. Plan a maintenance window, stop writes, export and validate the current snapshot, restore to an isolated destination, compare record counts, update DATABASE_URL privately, verify health and workflows, and make a rollback plan. Never set ALLOW_EMPTY_PRODUCTION_STATE=true simply to bypass a migration failure. No migration or service upgrade has been performed by this change.

## Customer accounts
Pilot aliases only. A logged-in user can generate a single-use recovery code after reauthentication; only its hash is stored. New codes replace older codes; password rotation and successful recovery revoke sessions and recovery codes. This is not email identity verification, not a commercial customer signup process, and not a substitute for verified email/contact and reviewed retention.

## Remaining gates for commercial launch
- Durable database, tested restores, monitoring, operational capacity, and explicit backup schedule.
- Verified owner/business details, complete privacy notice, processor/transfer review, rights process and retention for customers, store representatives and couriers.
- Actual store agreements, lawful customer payment options, receipts/tax invoicing and reviewed fixed fee treatment.
- Verified email signup/recovery, secure order data retention and customer support/cancellation/refund processes.
- Test on actual phones/tablets, including background notification limits. The shop sound/count works in the foreground only.
- Keep commercial orders and full real applications disabled until the responsible operator approves and verifies these gates. No payment processor, real transaction or automatic freelancer dispatch is enabled.
