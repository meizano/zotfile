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
 */

Zotero.ZotFile.Rclone = new function() {

    var zz = Zotero.ZotFile,
        sep = Zotero.isWin ? '\\' : '/';

    // cache for the resolved rclone executable
    var _exeCache = { pref: null, exe: null };

    var isEnabled = function() {
        return !!zz.getPref('rclone.enabled');
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
            var result = await run(['copyto', zz.Path.normalize(path), remote]);
            if (result.code !== 0) throw new Error(result.stderr.trim() || ('exit code ' + result.code));
        }
        catch (e) {
            reportError(e);
        }
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
            var result = await run(['copyto', remote, zz.Path.normalize(path)]);
            if (result.code !== 0) throw new Error(result.stderr.trim() || ('exit code ' + result.code));
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
        if (await zz.Path.exists(path)) return true;
        if (!isEnabled()) return false;
        await this.downloadFile(path);
        return await zz.Path.exists(path);
    };
};
