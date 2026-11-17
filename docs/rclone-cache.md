# rclone sync and local LRU cache (ZotFile 6.3.0)

ZotFile can keep folders that are mapped to an rclone remote (for example Google Drive) in sync and cache files locally with a size limit.

## Setup

1. **OS path mapping** (Settings -> ZotFile -> Other Advanced Settings -> OS Path Mappings):
   pair the local paths of the same folder on each operating system and add the rclone remote:

   | Windows path | Linux/macOS path | rclone remote |
   |---|---|---|
   | `G:\My Drive` | `/home/user/MyDrive` | `gdrive:MyDrive` |

2. Enable **Sync mapped folders with rclone** and set the rclone executable
   (full path, or just `rclone` when it is on the PATH).

3. **Limit local cache** (on by default, 1 GB): files in mapped folders are kept
   locally until the total size exceeds the limit.

## How it works

- **Upload**: files that ZotFile copies or moves into a mapped folder
  (renamed attachments, files sent to the tablet folder) are uploaded with
  `rclone copyto`. With *Verify uploads on the remote* enabled, the upload is
  confirmed with `rclone lsjson --stat` (fallback `rclone size --json`) and the
  result is recorded in the cache index.
- **Download**: files that are missing locally are fetched automatically before
  use (attachment on the tablet, "Fetch from Drive").
- **LRU eviction**: when the cache exceeds its limit, the least recently used
  files are removed locally — only after the remote copy has been verified.
  Never evicted: files outside mapped folders, files that were never uploaded,
  zero-size files, and files touched within the last minute.
- **Deletion**: when ZotFile removes a file (e.g. pulled back from the tablet),
  the remote copy is deleted as well. Cache entries for files that disappear
  locally are marked `local:false` on the next eviction run; the remote copy is
  never touched by this cleanup.
- **Fetch on demand**: right-click attachment(s) -> Manage Attachments ->
  *Fetch from Drive* downloads the file from the remote and opens it in Zotero.
- Eviction also runs ~10 s after startup and every 60 minutes; the *Clear now*
  button in the settings runs it immediately.

## Preferences

| Preference | Default | Meaning |
|---|---|---|
| `extensions.zotfile.rclone.enabled` | `false` | Enable rclone sync |
| `extensions.zotfile.rclone.path` | `rclone` | rclone executable |
| `extensions.zotfile.rclone.cache.enabled` | `true` | Limit the local cache |
| `extensions.zotfile.rclone.cache.maxGB` | `1` | Cache limit in GB (`0` = unlimited) |
| `extensions.zotfile.rclone.cache.verifyUpload` | `true` | Verify uploads on the remote |
| `extensions.zotfile.rclone.cache.touchOnOpen` | `true` | Update LRU order when an attachment is opened (best effort) |

The cache index is stored as `zotfile-rclone-cache.json` in the Zotero profile
directory and is written atomically (`.tmp` file, then replace).

Notes:

- The LRU order is approximate: it is based on upload/fetch/open activity
  observed by the plugin, not on every read of the file.
- Deleting an attachment in Zotero does not delete the file on the remote.
- With `rclone.enabled=false` none of these features are active.

## Manual test checklist

1. **Eviction**: set *Local cache limit* to `0.001` GB (~1 MB), then
   rename/move three files of ~500 KB each into a mapped folder. Result: only
   the most recent file remains locally, all three files exist on the remote
   (`rclone ls gdrive:MyDrive/...`), and the cache status label shows a total
   at or below the limit.
2. **No unsafe deletion**: delete one of the files on the remote manually
   (`rclone deletefile`), set the limit to `0.0001` GB and run *Clear now*.
   Result: the unverified file is **not** removed locally and a warning is shown.
3. **Fetch**: open an attachment whose local file was evicted -> right-click ->
   Manage Attachments -> *Fetch from Drive*. The file is restored with identical
   content (compare checksums with `rclone hash MD5`).
4. **Offline**: disconnect the network, run *Clear now* and *Fetch from Drive*.
   Result: eviction removes nothing (verification fails), fetch shows a clear
   warning and marks the progress entry as failed.
5. **Restart**: restart Zotero — the cache index is read again and the status
   label shows the same usage as before.
6. **No mapping**: perform ZotFile operations with folders that have no rclone
   remote in the mapping — nothing is uploaded, downloaded or deleted.
7. **Disabled**: set *Sync mapped folders with rclone* off — all cache and sync
   features are inactive, the local files are never touched.

## Build

```
python build.py      # -> zotfile-<version>.xpi
```

Install the `.xpi` in Zotero via Tools -> Plugins -> gear icon ->
Install Plugin From File.
