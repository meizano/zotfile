
/**
 * Zotero.ZotFile.Path
 * Functions to work with file paths (replaces the removed OS.Path and OS.File modules)
 */
Zotero.ZotFile.Path = new function() {

    var sep = Zotero.isWin ? '\\' : '/';

    // current platform key used in the path mappings
    var platform = Zotero.isWin ? 'windows' : Zotero.isMac ? 'mac' : 'linux';

    // cache for the parsed 'pathMappings' preference
    var _mappingsCache = { pref: null, rules: [] };

    var getMappings = function() {
        var pref = Zotero.Prefs.get('extensions.zotfile.pathMappings', true) || '[]';
        if (_mappingsCache.pref !== pref) {
            try {
                var rules = JSON.parse(pref);
                _mappingsCache = { pref: pref, rules: Array.isArray(rules) ? rules.filter(rule => rule && typeof rule == 'object') : [] };
            }
            catch (e) {
                _mappingsCache = { pref: pref, rules: [] };
            }
        }
        return _mappingsCache.rules;
    };

    // canonical form for prefix comparison: forward slashes, no trailing
    // separator, lowercased for case-insensitive file systems
    var canonical = function(path, caseInsensitive) {
        path = String(path).replace(/\\/g, '/').replace(/\/+$/, '');
        return caseInsensitive ? path.toLowerCase() : path;
    };

    // windows-style prefixes (drive letter, UNC path) are case-insensitive
    var isWindowsPrefix = function(path) {
        return /^[A-Za-z]:/.test(path) || String(path).startsWith('//');
    };

    /**
     * Map a path to the current platform based on the 'pathMappings' preference.
     * The preference holds a JSON array of rules such as
     *     [{"windows": "G:\\My Drive", "linux": "/home/user/GDrive"}]
     * The folder before and after mapping has to point to the same location.
     * Paths already using the current platform's prefix are left unchanged.
     * @param  {string} path Path to map
     * @return {string}      Mapped path (unchanged if no rule matches)
     */
    this.map = function(path) {
        path = String(path);
        var rules = getMappings();
        if (rules.length === 0) return path;
        // canonical form of the path without lowercasing (length is preserved
        // for slicing) and without trailing separators
        var pathCanon = path.replace(/\\/g, '/');
        var pathCompare = Zotero.isWin ? pathCanon.toLowerCase() : pathCanon;
        // no mapping needed if the path already starts with the prefix of the current platform
        for (let rule of rules) {
            let own = rule[platform];
            if (!own) continue;
            let ownCanon = canonical(own, Zotero.isWin);
            if (pathCompare === ownCanon || pathCompare.startsWith(ownCanon + '/'))
                return path;
        }
        // otherwise, map from the prefix of another platform
        for (let rule of rules) {
            for (let os in rule) {
                let prefix = rule[os];
                // only map between platform prefixes ('remote' holds the rclone remote)
                if (!['windows', 'mac', 'linux'].includes(os) || os === platform || !prefix) continue;
                // windows-style prefixes (drive letter, UNC path) are matched case-insensitively
                let ci = isWindowsPrefix(prefix);
                let prefixCanon = canonical(prefix, ci);
                let prefixCompare = ci ? prefixCanon.toLowerCase() : prefixCanon;
                let pathCmp = ci ? pathCompare.toLowerCase() : pathCompare;
                if (pathCmp !== prefixCompare && !pathCmp.startsWith(prefixCompare + '/'))
                    continue;
                let mapped = rule[platform];
                if (!mapped) return path;
                return String(mapped).replace(/[\\/]+$/, '') + pathCanon.slice(prefixCanon.length).replace(/\//g, sep);
            }
        }
        return path;
    };

    /**
     * Normalize path: map to the current platform, use the platform separator,
     * remove duplicate and trailing separators, and resolve '.' and '..'
     * @param  {string} path Path (absolute or relative)
     * @return {string}      Normalized path
     */
    this.normalize = function(path) {
        path = this.map(String(path)).trim();
        var prefix = '', absolute = false;
        if (Zotero.isWin) {
            path = path.replace(/\//g, '\\');
            // UNC path such as \\server\share
            if (path.startsWith('\\\\')) {
                prefix = '\\\\';
                path = path.slice(2);
            }
            // drive such as C:
            else if (/^[A-Za-z]:/.test(path)) {
                prefix = path.slice(0, 2);
                path = path.slice(2);
                absolute = path.startsWith('\\');
            }
            else {
                absolute = path.startsWith('\\');
            }
        }
        else {
            absolute = path.startsWith('/');
        }
        var parts = [];
        for (let part of path.split(sep)) {
            if (part == '' || part == '.') continue;
            if (part == '..') {
                if (parts.length > 0 && parts[parts.length - 1] != '..') parts.pop();
                else if (!absolute && prefix == '') parts.push(part);
                continue;
            }
            parts.push(part);
        }
        return prefix + (absolute ? sep : '') + parts.join(sep);
    };

    /**
     * Join path components (empty components are ignored)
     * @return {string} Normalized path
     */
    this.join = function() {
        var parts = Array.prototype.slice.call(arguments)
            .filter(part => part !== undefined && part !== null && part !== '');
        return this.normalize(parts.join(sep));
    };

    /**
     * Get the filename from a path
     */
    this.basename = function(path) {
        path = String(path);
        var pos = Zotero.isWin
            ? Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'))
            : path.lastIndexOf('/');
        return path.substr(pos + 1);
    };

    /**
     * Get the parent folder from a path
     */
    this.dirname = function(path) {
        path = this.normalize(path);
        var pos = path.lastIndexOf(sep);
        if (pos == -1) return '.';
        var dir = path.substr(0, pos);
        // root folders such as '/' or 'C:\'
        if (dir == '' || /^[A-Za-z]:$/.test(dir)) dir += sep;
        return dir;
    };

    /**
     * Check whether a file or folder exists (false for empty or invalid paths)
     * @param  {string} path Path to file or folder
     * @return {Promise<bool>}
     */
    this.exists = async function(path) {
        if (typeof path != 'string' || path.trim() == '') return false;
        try {
            return await IOUtils.exists(this.normalize(path));
        }
        catch (e) {
            return false;
        }
    };
};

/**
 * Zotero.ZotFile.Utils
 * Utility functions
 */
Zotero.ZotFile.Utils = new function() {

    /**
     * Remove element from array
     * @param  {array} arr Array
     * @return {array}     Array with element removed
     */
    this.removeFromArray = function (arr) {
        var what, a = Array.prototype.slice.call(arguments).splice(1), L = a.length, ax;
        while (L && arr.length) {
            what = a[--L];
            while ((ax = arr.indexOf(what)) !== -1) {
                arr.splice(ax, 1);
            }
        }
        return arr;
    };

    /**
     * Search and replace elements in array
     * @param  {array}  x
     * @param  {string} search  Search terms
     * @param  {string} replace Replace with
     * @return {array}          Updated array
     */
    this.arrayReplace = function(x, search, replace) {
        for(var i = 0; i < x.length; i++) {
            if(x[i] == search) x.splice(i, 1, replace);
        }
        return(x);
    };

    /**
     * Filter array with an asynchronous test function
     * @param  {array}    arr Array
     * @param  {function} fn  Function returning a bool or a promise for a bool
     * @return {Promise<array>}
     */
    this.asyncFilter = async function(arr, fn) {
        var keep = await Promise.all(arr.map(x => fn(x)));
        return arr.filter((x, i) => keep[i]);
    };

    /**
     * Get collection path from Zotero.Item
     * @param  {Zotero.Item}
     * @return {array}          Array with paths that reflect zotero items
     */
    this.getCollectionPathsOfItem = function(item) {
        var getCollectionPath = function(collectionID) {
            var collection = Zotero.Collections.get(collectionID);
            if (!collection) return '';
            var name = Zotero.File.getValidFileName(collection.name);
            if (!collection.parentID) return name;
            return getCollectionPath(collection.parentID) + Zotero.ZotFile.folderSep + name;
        };
        return item.getCollections().map(getCollectionPath);
    };

    /**
     * Add suffix to filename
     * @param {string}  filename The filename
     * @param {integer} k        The suffix
     */
    this.addSuffix = function(filename, k) {
        return filename.replace(/(\.[\w\d]*)$/i, k + "$1");
    };

    /**
     * Add numerical suffix to filename
     * @param {string}  filename The filename
     * @param {integer} k        The suffix
     */
    this.addNumericalSuffix = function(filename, k) {
        if (!/\.[\w\d]*$/.test(filename)) return filename + ' ' + k;
        return filename.replace(/(\.[\w\d]*)$/, ' ' + k + "$1");
    };

    /**
     * Get the file type from a filename
     * @param  {string} filename Filename with file extension.
     * @return {string}          File type.
     */
    this.getFiletype = function(filename) {
        if (typeof filename != 'string')
            throw new Error("Zotero.ZotFile.Utils.getFiletype(): 'path' is not a string.");
        var pos = filename.lastIndexOf('.');
        return pos == -1 ? '' : filename.substr(pos + 1);
    };

    /**
     * Format string using named placeholders such as '%(name)'
     * @return {str}
     */
    this.str_format = function(str, args) {
        return str.replace(/%\((\w+)\)/g, (match, name) => args[name]);
    };

    /**
     * Copy text to clipboard
     * @param  {string} txt Text to copy to clipboard
     * @return {void}
     */
    this.copy2Clipboard = function(txt) {
        Components.classes["@mozilla.org/widget/clipboardhelper;1"]
            .getService(Components.interfaces.nsIClipboardHelper)
            .copyString(txt);
    };

    /**
     * Open URL in the default browser
     * @param  {string} uri URL
     * @return {void}
     */
    this.loadURI = function(uri) {
        Zotero.launchURL(uri);
    };
};
