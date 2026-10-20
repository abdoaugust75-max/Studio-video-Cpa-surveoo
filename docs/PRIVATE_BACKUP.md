# Private configuration recovery

The private repository includes an **encrypted** snapshot under
`private-backup/2026-10-20/`. It contains configuration/API credentials, page
instructions, Telegram memory, publication/source registries and owner assets.
Downloaded/generated media, caches, locks and installed runtimes are excluded.
The original installation is not modified or cleaned by taking this snapshot.

The AES-256-GCM recovery key is kept **outside GitHub and Notion**, on the owner's
computer under `C:\Users\abdelilah\Documents\VideoStudio-Recovery\2026-10-20.key`.
Keep a separate private copy of that key. Without it the snapshot cannot be opened.
Never commit it or paste it into chat, issues, logs or Notion. This is a point-in-time
backup, not automatic synchronization and not evidence that saved tokens remain valid.

Verify without writing decrypted files:

```powershell
node tools/private-state-backup.js verify private-backup/2026-10-20 C:\Users\abdelilah\Documents\VideoStudio-Recovery\2026-10-20.key
```

Restore only into a new directory, with the key supplied privately on that computer:

```powershell
node tools/private-state-backup.js restore private-backup/2026-10-20 C:\path\to\recovery.key C:\path\to\new-private-state
```

The tool validates all parts, authenticated decryption, file hashes and relative
paths before extraction. It refuses an existing target and forces publishing held
and scheduling off in the recovered copy. It does not start a worker or contact any
API. Keep the live worker stopped before a later migration; review recovered jobs,
absolute Windows paths and tokens before enabling any worker on another computer.
Only one worker may use a given state folder.

This archive was taken while the local service existed: it preserves individual
file snapshots, not a database transaction spanning every journal. Installed tool
binaries and model weights must still be installed or copied separately. Generated
videos excluded from the backup cannot be recovered from metadata alone.

Normal `npm run release` remains a source-only release and excludes this encrypted
snapshot. Plain configuration is never part of the source release.
