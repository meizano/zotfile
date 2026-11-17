/**
 * Zotero.ZotFile.Rclone
 * Sync files in mapped folders with an rclone remote (e.g. Google Drive)
 *
 * The rclone remote is configured per folder in the OS path mappings
 * ('pathMappings' preference): a rule such as
 *     {"windows": "G:\\My Drive", "linux": "/media/user/GDrive", "remote": "gdrive:MyDrive"}
 * links the local folder on each operating system to the same remote. Files that
 * ZotFile copies, moves or removes inside such a folder are uploaded, downloaded
 * or deleted on the remote with the rclone command line tool.
 *
 * An LRU cache (default limit 1 GB) keeps uploaded files locally and removes
 * the least recently used files only after their existence on the remote has
 * been verified. Removed files can be fetched on demand.
 */

Zotero.ZotFile.Rclone = new function() {

    var zz = Zotero.ZotFile,
        sep = Zotero.isWin ? '\\' : '/';

    // cache for the resolved rclone executable
    var _exeCache = { pref: null, exe: null };

    // serialized access to the cache index (uploads, downloads, eviction)
    var _queue = Promise.resolve();

    // in-memory copy of the cache index
    var _index = null;

    var isEnabled = function() {
        return !!zz.getPref('rclone.enabled');
    };

    var cacheEnabled = function() {
        return isEnabled() && !!zz.getPref('rclone.cache.enabled');
    };

    /**
     * Serialize a function so that cache operations do not interleave
     */
    var withLock = async function(fn) {
        var result;
        var next = async function() {
            result = await fn();
        };
        _queue = _queue.then(next, next);
        await _queue;
        return result;
    };

    /**
     * Resolve the rclone executable: full path as configured, or search the
     * PATH environment variable for a bare name such as 'rclone'
     */
    var resolveExe = async function() {
        var pref = String(zz.getPref('rclone.path')).trim();
        if (pref == '') return null;
        if (/[\\\/]/.test(pref)) return pref;
        if (_exeCache.pref === pref) return _exeCache.exe;
        var exe = pref;
        try {
            var env = Components.classes['@mozilla.org/process/environment;1']
                    .getService(Components.interfaces.nsIEnvironment),
                dirs = env.get('PATH').split(Zotero.isWin ? ';' : ':');
            for (let dir of dirs) {
                for (let name of (Zotero.isWin ? [pref + '.exe', pref + '.cmd', pref] : [pref])) {
                    let candidate = dir ? dir + sep + name : name;
                    try {
                        if (await IOUtils.exists(candidate)) {
                            exe = candidate;
                            break;
                        }
                    }
                    catch (e) {}
                }
                if (exe != pref) break;
            }
        }
        catch (e) {}
        _exeCache = { pref: pref, exe: exe };
        return exe;
    };

    /**
     * Run rclone with the given arguments
     * @param  {array}  args Arguments passed to rclone
     * @return {object}      Object with exit code ('code'), 'stdout' and 'stderr'
     */
    var run = async function(args) {
        var exe = await resolveExe();
        if (!exe) throw new Error('rclone executable is not configured.');
        var Subprocess = ChromeUtils.import('resource://gre/modules/Subprocess.jsm').Subprocess;
        var proc = await Subprocess.call({
            command: exe,
            arguments: args,
            stdin: 'devnull',
            stderr: 'pipe'
        });
        var [stdout, stderr, code] = await Promise.all([
            proc.stdout.readString(),
            proc.stderr.readString(),
            proc.wait()
        ]);
        return { code: code, stdout: stdout, stderr: stderr };
    };

    /**
     * Get the rclone remote path (remote:path/to/file) for a local file, or
     * null if the file is not inside a folder with a configured remote
     * @param  {string} path Local file path (any platform's format)
     * @return {string}      Remote path or null
     */
    var findRemote = function(path) {
        var mappings;
        try {
            mappings = JSON.parse(zz.getPref('pathMappings') || '[]');
        }
        catch (e) {
            return null;
        }
        var pathCanon = String(path).replace(/\\/g, '/').replace(/\/+$/, '');
        for (let rule of Array.isArray(mappings) ? mappings : []) {
            if (!rule || typeof rule != 'object' || !rule.remote) continue;
            for (let os of ['windows', 'mac', 'linux']) {
                let prefix = rule[os];
                if (!prefix) continue;
                // windows-style prefixes (drive letter, UNC path) are matched case-insensitively
                let ci = /^[A-Za-z]:/.test(prefix) || String(prefix).startsWith('//');
                let canon = String(prefix).replace(/\\/g, '/').replace(/\/+$/, '');
                if (ci) canon = canon.toLowerCase();
                let cmp = ci ? pathCanon.toLowerCase() : pathCanon;
                if (cmp !== canon && !cmp.startsWith(canon + '/')) continue;
                return String(rule.remote).replace(/[\\\/]+$/, '') + pathCanon.slice(canon.length);
            }
        }
        return null;
    };

    /**
     * Report an rclone failure without interrupting the ZotFile operation
     */
    var reportError = function(e) {
        var message = 'rclone: ' + (e.message || e);
        Zotero.logError(e);
        zz.messages_warning.push(message);
    };

    // ================== //
    //  LRU  FILE  CACHE  //
    // ================== //

    /**
     * Path of the cache index file in the Zotero profile directory
     */
    var cacheIndexPath = function() {
        var base = (Zotero.Profile && Zotero.Profile.dir) ? Zotero.Profile.dir : Zotero.DataDirectory.dir;
        return zz.Path.join(base, 'zotfile-rclone-cache.json');
    };

    /**
     * Load the cache index from disk (once per session)
     */
    var loadIndex = async function() {
        if (_index) return _index;
        _index = { version: 1, entries: {} };
        try {
            var path = cacheIndexPath();
            if (await IOUtils.exists(path)) {
                let data = JSON.parse(await IOUtils.readUTF8(path));
                if (data && data.version == 1 && data.entries && typeof data.entries == 'object')
                    _index.entries = data.entries;
            }
        }
        catch (e) {
            Zotero.logError(e);
        }
        return _index;
    };

    /**
     * Write the cache index atomically: write to '.tmp' first, then replace
     */
    var saveIndex = async function() {
        if (!_index) return;
        try {
            var path = cacheIndexPath();
            await IOUtils.writeUTF8(path + '.tmp', JSON.stringify(_index, null, 2));
            await IOUtils.move(path + '.tmp', path);
        }
        catch (e) {
            Zotero.logError(e);
        }
    };

    /**
     * Size of a local file in bytes (0 if not available)
     */
    var fileSize = async function(path) {
        try {
            return (await IOUtils.stat(zz.Path.normalize(path))).size;
        }
        catch (e) {
            return 0;
        }
    };

    /**
     * Verify that a file exists on the remote and has the expected size
     * @param  {string} remote   Remote path (remote:path/to/file)
     * @param  {number} size     Expected size in bytes
     * @return {bool}
     */
    var verifyRemote = async function(remote, size) {
        try {
            var result = await run(['lsjson', remote, '--stat']);
            if (result.code === 0) {
                let data = JSON.parse(result.stdout),
                    obj = Array.isArray(data) ? data[0] : data;
                return !!(obj && typeof obj.Size == 'number' && obj.Size == size && size > 0);
            }
            // fall back to 'rclone size --json'
            result = await run(['size', remote, '--json']);
            if (result.code !== 0) return false;
            let stat = JSON.parse(result.stdout);
            return !!(stat && stat.bytes == size && size > 0);
        }
        catch (e) {
            return false;
        }
    };

    /**
     * Add or update the cache entry for a local file
     */
    var recordEntry = async function(path, remote, verified) {
        var index = await loadIndex(),
            key = zz.Path.normalize(path);
        index.entries[key] = {
            remote: remote,
            size: await fileSize(key),
            uploadedAt: Date.now(),
            lastUsed: Date.now(),
            local: true,
            verified: !!verified
        };
        await saveIndex();
    };

    /**
     * Remove the cache entry for a local file (e.g. after a move or deletion)
     */
    var removeEntry = async function(path) {
        var index = await loadIndex(),
            key = zz.Path.normalize(path);
        if (key in index.entries) {
            delete index.entries[key];
            await saveIndex();
        }
    };

    /**
     * Update 'lastUsed' for a cache entry (LRU touch)
     */
    var touchEntry = async function(path) {
        var index = await loadIndex(),
            key = zz.Path.normalize(path),
            entry = key in index.entries ? index.entries[key] : null;
        if (!entry) return;
        entry.lastUsed = Date.now();
        await saveIndex();
    };

    /**
     * Evict the least recently used local files until the cache is within its
     * size limit. Files are only removed after their existence on the remote
     * has been verified. Files outside mapped folders, files that were never
     * uploaded, zero-size files and files touched within the last minute are
     * never evicted.
     */
    this.evict = async function() {
        if (!cacheEnabled()) return;
        await withLock(async function() {
            try {
                var maxGB = parseFloat(zz.getPref('rclone.cache.maxGB')),
                    maxBytes = maxGB * 1073741824,
                    index = await loadIndex(),
                    now = Date.now();
                if (!(maxBytes > 0)) return; // 0 = unlimited
                var total = 0,
                    locals = [];
                for (let key in index.entries) {
                    let entry = index.entries[key];
                    if (!entry || !entry.local) continue;
                    if (!(await IOUtils.exists(key))) {
                        // stale entry: the local file is gone
                        entry.local = false;
                        continue;
                    }
                    if (!entry.remote || !(entry.size > 0)) continue;
                    // skip files touched recently (they might be in use)
                    if (entry.lastUsed && now - entry.lastUsed < 60000) {
                        total += entry.size;
                        continue;
                    }
                    // only evict files that are still inside a mapped folder
                    if (!findRemote(key)) {
                        entry.verified = false;
                        continue;
                    }
                    locals.push({ key: key, entry: entry, lastUsed: entry.lastUsed || 0 });
                    total += entry.size;
                }
                if (total <= maxBytes) {
                    await saveIndex();
                    return;
                }
                locals.sort((a, b) => a.lastUsed - b.lastUsed);
                var evicted = 0;
                for (let item of locals) {
                    if (total <= maxBytes) break;
                    // verify the remote copy before removing the local file
                    let ok = await verifyRemote(item.entry.remote, item.entry.size);
                    if (!ok) {
                        item.entry.verified = false;
                        zz.messages_warning.push("rclone: local file '" + zz.Path.basename(item.key) +
                            "' was not evicted because it could not be verified on the remote.");
                        Zotero.debug("zotfile rclone: eviction skipped for '" + item.key + "' (remote verification failed)");
                        continue;
                    }
                    try {
                        await IOUtils.remove(item.key);
                    }
                    catch (e) {
                        Zotero.logError(e);
                        continue;
                    }
                    item.entry.local = false;
                    item.entry.verified = true;
                    total -= item.entry.size;
                    evicted++;
                }
                await saveIndex();
                if (evicted > 0) Zotero.debug('zotfile rclone: evicted ' + evicted + ' file(s) from the local cache');
            }
            catch (e) {
                Zotero.logError(e);
            }
        });
    };

    /**
     * Statistics of the local cache: {bytes, files} for entries whose file
     * still exists locally
     */
    this.cacheStats = async function() {
        var stats = { bytes: 0, files: 0 };
        if (!cacheEnabled()) return stats;
        var index = await loadIndex();
        for (let key in index.entries) {
            let entry = index.entries[key];
            if (!entry || !entry.local || !(entry.size > 0)) continue;
            if (!(await IOUtils.exists(key))) continue;
            stats.bytes += entry.size;
            stats.files++;
        }
        return stats;
    };

    /**
     * Run eviction now (also used by the 'Clear now' button and timers)
     * @param  {bool} force Run even if the cache is currently within its limit
     * @return {void}
     */
    this.clearCache = async function(force) {
        if (!cacheEnabled()) return;
        var stats = await this.cacheStats();
        if (!force && stats.bytes <= parseFloat(zz.getPref('rclone.cache.maxGB')) * 1073741824) return;
        await this.evict();
    };

    /**
     * LRU touch for a file that was just used (opened, fetched, ...)
     */
    this.touch = function(path) {
        if (!cacheEnabled() || !path) return Promise.resolve();
        return withLock(() => touchEntry(path)).catch(e => Zotero.logError(e));
    };

    /**
     * LRU touch for attachments that are opened by the user (best effort,
     * called from the wrapped ZoteroPane.viewAttachment)
     */
    this.touchAttachments = async function(items) {
        try {
            if (!cacheEnabled() || !zz.getPref('rclone.cache.touchOnOpen')) return;
            for (let item of items) {
                if (!item || !item.isAttachment() || item.isTopLevelItem()) continue;
                let path = await item.getFilePathAsync();
                if (path) await this.touch(path);
            }
        }
        catch (e) {
            Zotero.logError(e);
        }
    };

    /**
     * Periodic eviction timer (started on plugin init)
     */
    this.startTimers = function() {
        if (!isEnabled() || this._timer) return;
        // initial eviction ~10s after startup
        setTimeout(() => { if (cacheEnabled()) this.evict(); }, 10000);
        // periodic eviction (every 60 minutes)
        this._timer = setInterval(() => { if (cacheEnabled()) this.evict(); }, 3600000);
    };

    this.stopTimers = function() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = null;
        }
    };

    // =========== //
    //  RCLONE IO  //
    // =========== //

    /**
     * Upload a local file to the rclone remote
     * @param  {string} path Local file path
     * @return {void}
     */
    this.uploadFile = async function(path) {
        if (!isEnabled()) return;
        try {
            var remote = findRemote(path);
            if (!remote) return;
            var local = zz.Path.normalize(path);
            await withLock(async function() {
                var result = await run(['copyto', local, remote]);
                if (result.code !== 0) throw new Error(result.stderr.trim() || ('exit code ' + result.code));
                // cache bookkeeping
                if (cacheEnabled()) {
                    var verified = true;
                    if (zz.getPref('rclone.cache.verifyUpload'))
                        verified = await verifyRemote(remote, await fileSize(local));
                    if (!verified)
                        zz.messages_warning.push("rclone: upload of '" + zz.Path.basename(local) +
                            "' could not be verified on the remote.");
                    await recordEntry(local, remote, verified);
                }
            });
        }
        catch (e) {
            reportError(e);
            return;
        }
        // evict least recently used files after a successful upload
        if (cacheEnabled()) this.evict();
    };

    /**
     * Download a file from the rclone remote
     * @param  {string} path Local file path
     * @return {void}
     */
    this.downloadFile = async function(path) {
        if (!isEnabled()) return;
        try {
            var remote = findRemote(path);
            if (!remote) return;
            var local = zz.Path.normalize(path);
            await withLock(async function() {
                var result = await run(['copyto', remote, local]);
                if (result.code !== 0) throw new Error(result.stderr.trim() || ('exit code ' + result.code));
                if (cacheEnabled()) await recordEntry(local, remote, true);
            });
        }
        catch (e) {
            reportError(e);
        }
    };

    /**
     * Delete a file on the rclone remote
     * @param  {string} path Local file path that corresponds to the remote file
     * @return {void}
     */
    this.deleteFile = async function(path) {
        if (!isEnabled()) return;
        try {
            var remote = findRemote(path);
            if (!remote) return;
            var result = await run(['deletefile', remote]);
            if (result.code !== 0) throw new Error(result.stderr.trim() || ('exit code ' + result.code));
            if (cacheEnabled()) await withLock(() => removeEntry(path));
        }
        catch (e) {
            reportError(e);
        }
    };

    /**
     * Make sure a file is available locally; download from the remote if missing
     * @param  {string} path Local file path
     * @return {bool}        Whether the file exists locally afterwards
     */
    this.ensureFile = async function(path) {
        if (await zz.Path.exists(path)) {
            if (cacheEnabled()) await this.touch(path);
            return true;
        }
        if (!isEnabled()) return false;
        await this.downloadFile(path);
        var exists = await zz.Path.exists(path);
        if (!exists)
            zz.messages_warning.push("rclone: file '" + zz.Path.basename(String(path)) +
                "' could not be fetched from the remote (check your connection).");
        return exists;
    };
};
