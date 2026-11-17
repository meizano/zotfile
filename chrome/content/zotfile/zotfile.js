/**
ZotFile: Advanced PDF management for Zotero
Joscha Legewie

Zotfile is a Zotero plugin to manage your attachments:
automatically rename, move, and attach PDFs (or other files)
to Zotero items.

Webpage: http://www.zotfile.com
Github: https://github.com/jlegewie/zotfile

License
The source code is released under GNU General Public License, version 3.0
Contributions preferably through pull requests are welcome!

This file is loaded by bootstrap.js into the plugin scope (Zotero 7 and later).
Globals provided by Zotero: Zotero, Services, IOUtils, Components
*/


Zotero.ZotFile = new function() {
    this.id = 'zotfile@columbia.edu';
    this.version = null;
    this.rootURI = null;
    this.prefPaneID = 'zotfile-prefpane';
    this.folderSep = Zotero.isWin ? '\\' : '/';
    this.zotfileURL = 'http://www.zotfile.com';
    this.messages_warning = [];
    this.messages_report = [];
    this.messages_error = [];
    this.messages_fatalError = [];
    this.excludeAutorenameKeys = [];
    this.notifierID = null;

    var _stringBundle = null;

    /**
     * Initiate zotfile (called once from bootstrap.js on startup)
     * @param  {object} params Object with id, version and rootURI of the plugin
     * @return {void}
     */
    this.init = async function (params) {
        // information about attachments on the tablet
        await this.Tablet.loadStore();
        this.id = params.id;
        this.version = params.version;
        this.rootURI = params.rootURI;
        // the Firefox download folder is not available in Zotero; always use the custom source folder
        if (this.getPref('source_dir_ff')) this.setPref('source_dir_ff', false);
        // remember current version
        if (this.getPref('version') != this.version) this.setPref('version', this.version);
        // Register callbacks in Zotero as item observers
        if (this.notifierID === null)
            this.notifierID = Zotero.Notifier.registerObserver(this.notifierCallback, ['item'], 'zotfile');
        // start the LRU cache eviction timers of the rclone integration
        if (this.getPref('rclone.enabled')) this.Rclone.startTimers();
    };

    /**
     * Clean up (called from bootstrap.js when the plugin is disabled or removed)
     * @return {void}
     */
    this.shutdown = function () {
        this.Rclone.stopTimers();
        if (this.notifierID !== null) {
            Zotero.Notifier.unregisterObserver(this.notifierID);
            this.notifierID = null;
        }
        _stringBundle = null;
    };

    /**
     * Get the main Zotero window
     * @return {Window}
     */
    this.getMainWindow = function () {
        return Zotero.getMainWindow();
    };

    // Localization
    this.ZFgetString = function (name, params) {
        if (!_stringBundle)
            _stringBundle = Services.strings.createBundle('chrome://zotfile/locale/zotfile.properties');
        try {
            if (params !== undefined) {
                if (!Array.isArray(params)) params = [params];
                return _stringBundle.formatStringFromName(name, params.map(String));
            }
            return _stringBundle.GetStringFromName(name);
        }
        catch (e) {
            throw new Error('Localized string not available for ' + name);
        }
    };

    /**
     * Get preference value in 'extensions.zotfile' branch
     * @param  {string} pref     Name of preference in 'extensions.zotfile' branch
     * @return {string|int|bool} Value of preference.
     */
    this.getPref = function(pref) {
        return Zotero.Prefs.get('extensions.zotfile.' + pref, true);
    };

    /**
     * Set preference value in 'extensions.zotfile' branch
     * @param {string}          pref  Name of preference in 'extensions.zotfile' branch
     * @param {string|int|bool} value Value of preference
     */
    this.setPref = function(pref, value) {
        Zotero.Prefs.set('extensions.zotfile.' + pref, value, true);
    };

    /**
     * Get parent item
     * @param  {Zotero.Item} item Zotero item
     * @return {Zotero.Item}      Returns parent item
     */
    this.getParent = function(item) {
        return Zotero.Items.get(item.parentItemID);
    };

    /**
     * Get array of select attachment IDs including all attachments for selected regular items
     * @return {array}    Array with attachment ids
     */
    this.getSelectedAttachments = function () {
        var win = this.getMainWindow();
        if (!win || !win.ZoteroPane) return [];
        var attachments = win.ZoteroPane.getSelectedItems()
            .map(item => item.isRegularItem() ? item.getAttachments() : item)
            .reduce((a, b) => a.concat(b), [])
            .map(item => typeof item == 'number' ? Zotero.Items.get(item) : item)
            .filter(item => item.isAttachment())
            .filter(att => att.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_URL)
            .map(att => att.id);
        // remove duplicate elements and return array with attachment ids
        return Array.from(new Set(attachments));
    };

    /**
     * Open zotfile preferences (a pane in the Zotero settings window)
     */
    this.openPreferenceWindow = function(scrollTo) {
        Zotero.Utilities.Internal.openPreferences(this.prefPaneID, scrollTo ? {scrollTo: scrollTo} : {});
    };

    /**
     * Simple dialogs
     */
    this.alert = function(message) {
        Services.prompt.alert(this.getMainWindow(), 'ZotFile', message);
    };

    this.confirm = function(message) {
        return Services.prompt.confirm(this.getMainWindow(), 'ZotFile', message);
    };

    this.promptInput = function(message, default_str) {
        var input = {value: default_str === undefined ? '' : default_str};
        var ok = Services.prompt.prompt(this.getMainWindow(), 'ZotFile', message, input, null, {value: false});
        return ok ? input.value : null;
    };

    /**
     * Choose directory from file picker
     * @return {string} Path to folder or empty string
     */
    this.chooseDirectory = async function (win) {
        win = win || this.getMainWindow();
        var { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
        var fp = new FilePicker();
        fp.init(win, Zotero.getString('dataDir.selectDir'), fp.modeGetFolder);
        fp.appendFilters(fp.filterAll);
        if (await fp.show() != fp.returnOK) return '';
        return fp.file;
    };

    // show report messages
    this.showReportMessages = function(title){
        if(this.messages_report.length > 0) this.infoWindow(title, {lines: this.messages_report});
        this.messages_report = [];
    };

    // show warnings messages
    this.showWarningMessages = function(title, txt){
        txt = typeof txt !== 'undefined' ? txt : '';
        if(this.messages_warning.length > 0) this.infoWindow(title, {lines: this.messages_warning, txt: txt});
        this.messages_warning = [];
    };

    this.format_error = function(e) {
        var name = e.name ? e.name : 'Error',
            message = e.message ? e.message : 'undefined message',
            fileName = e.fileName ? e.fileName : (e.filename ? e.filename : 'undefined file'),
            lineNumber = e.lineNumber ? e.lineNumber : 'undefined line number';
        return name + ': ' + message + ' \n(' + fileName + ', ' + lineNumber + ')';
    };

    this.handleErrors = function(error_message) {
        if (error_message !== undefined) this.messages_error.push(error_message);
        var errors = {lines: this.messages_error},
            on_click = null,
            duration = this.getPref('info_window_duration');
        // fatal errors
        if(this.messages_fatalError.length > 0) {
            duration = this.getPref('info_window_duration_clickable');
            errors.lines.push(this.ZFgetString('error.unknown'));
            errors.txt = this.ZFgetString('error.clickToCopy');
            // prepare error message for clipboard
            var errors_str = this.messages_fatalError.map(e => {
                if (typeof e == 'object') Zotero.logError(e);
                return typeof e == 'object' ? this.format_error(e) : e;
            });
            errors_str = Array.from(new Set(errors_str)).join('\n\n');
            on_click = () => this.Utils.copy2Clipboard(errors_str);
        }
        // error messages
        if(errors.lines.length > 0) {
            // remove duplicates
            errors.lines = Array.from(new Set(errors.lines));
            // show errors
            this.infoWindow(this.ZFgetString('general.error'), errors, duration, on_click);
        }
        // empty error arrays
        this.messages_error = [];
        this.messages_fatalError = [];
    };

    /**
     * Wrapper around Zotero.ProgressWindow (the small notification popup) that adds
     * the functions zotfile relies on: a click callback and ItemProgress.complete()
     */
    this.ProgressWindow = function() {
        var pw = new Zotero.ProgressWindow({closeOnClick: true}),
            popup = null,
            callback = null;

        /**
         * Whether clicks on the popup can be observed (required for callbacks)
         */
        this.clickable = false;

        this.show = function() {
            // Zotero.ProgressWindow does not expose its window, but it synchronously registers
            // the window with Zotero.ProgressWindowSet in show(). Observe that call to get it.
            var set = Zotero.ProgressWindowSet,
                add = set.add;
            try {
                set.add = function(win) {
                    popup = win;
                    return add.apply(this, arguments);
                };
                pw.show();
            }
            finally {
                set.add = add;
            }
            if (popup) {
                this.clickable = true;
                popup.addEventListener('mouseup', function() {
                    if (callback === null) return;
                    var fn = callback;
                    callback = null;
                    fn();
                }, false);
            }
        };

        this.changeHeadline = function(text) { pw.changeHeadline(text); };
        this.addDescription = function(text) { pw.addDescription(text); };
        this.startCloseTimer = function(ms) { pw.startCloseTimer(ms); };
        this.close = function() { pw.close(); };
        this.addCallback = function(fn) { callback = fn; };

        /**
         * A line in the progress window
         * @param {string} icon  Name of item type icon, see Zotero.Item.getItemTypeIconName (or null)
         * @param {string} title Text
         */
        this.ItemProgress = function(icon, title) {
            var line = new pw.ItemProgress(icon, title);
            this.setProgress = function(percent) { line.setProgress(percent); };
            this.setTitle = function(text) { line.setText(text); };
            this.setIcon = function(icon) { if (icon) line.setItemTypeAndIcon(icon); };
            this.setError = function() { line.setError(); };
            this.complete = function(text, icon) {
                if (icon) line.setItemTypeAndIcon(icon);
                line.setText(text);
                line.setProgress(100);
            };
        };
    };

    /**
     * Get name of icon for item (for use with ProgressWindow.ItemProgress)
     */
    this.getIcon = function(item) {
        try {
            return item.getItemTypeIconName();
        }
        catch (e) {
            return 'attachment-file';
        }
    };

    this.infoWindow = function(main, message, time, callback){
        // default arguments
        main = typeof main !== 'undefined' ? main : 'title';
        message = typeof message !== 'undefined' ? message : 'message';
        callback = typeof callback !== 'undefined' ? callback : null;
        time = typeof time !== 'undefined' ? time : this.getPref('info_window_duration');
        // show window
        var pw = this.progressWindow(main);
        if (typeof(message) == 'object' && message.lines) {
            for (let i = 0; i < message.lines.length; i++) {
                let icon = message.icons ? message.icons[i] : null;
                let line = new pw.ItemProgress(icon, message.lines[i]);
                line.setProgress(100);
            }
            if (message.txt !== undefined) pw.addDescription(message.txt);
        }
        else if(typeof(message) == 'object') {
            pw.addDescription(JSON.stringify(message));
        }
        else
            pw.addDescription(message);

        pw.startCloseTimer(time);
        // add callback
        if (callback !== null)
            pw.addCallback(callback);
        // return window
        return(pw);
    };

    this.progressWindow = function(title) {
        var progressWin = new this.ProgressWindow();
        progressWin.changeHeadline(title);
        progressWin.show();
        return progressWin;
    };

    this.promptUser = function(message, but_0, but_1_cancel, but_2, title) {
        title = typeof title !== 'undefined' ? title : 'ZotFile';
        var prompts = Services.prompt;
        var check = {value: false};
        var flags = prompts.BUTTON_POS_0 * prompts.BUTTON_TITLE_IS_STRING +
                prompts.BUTTON_POS_1 * prompts.BUTTON_TITLE_IS_STRING  +
                prompts.BUTTON_POS_2 * prompts.BUTTON_TITLE_IS_STRING;
        return prompts.confirmEx(this.getMainWindow(), title, message,
                    flags, but_0, but_1_cancel, but_2, null, check);
    };

    this.addUserInput = function(filename, original_filename){
        var default_str = this.getPref('userInput_Default');
        if (default_str == '[original filename]') default_str = original_filename;
        var filesuffix = this.promptInput(this.ZFgetString('renaming.addUserInput.prompt', [original_filename, filename]), default_str);
        if (filesuffix != '' && filesuffix != null) {
            // add file type to the file name
            filename = filename + ' (' + filesuffix + ')';
        }
        return(filename);
    };

    this.checkFileType = function (att) {
        if(!Zotero.ZotFile.getPref('useFileTypes')) return true;
        var filename = att.attachmentFilename || '',
            pos = filename.lastIndexOf('.'),
            filetype = pos == -1 ? '' : filename.substr(pos + 1).toLowerCase(),
            filetypes = Zotero.ZotFile.getPref('filetypes').split(',').map(s => s.trim().toLowerCase());
        return filetypes.includes(filetype);
    };

    /**
     * Get filename based on metadata from zotero item
     * @param  {Zotero.Item}  item   Zotero item for metadata
     * @param  {string}       name   Current filename as fallback and for extension
     * @param  {string}       format Formatting rules based on wildcards
     * @param  {bool}         skipUserInput Never ask for user input (e.g. for previews)
     * @return {string}              Formatted filename with extension
     */
    this.getFilename = function(item, name, format, skipUserInput) {
        // check function arguments
        if (!item.isRegularItem()) throw new Error('getFilename: Not regular zotero item.');
        // check whether renaming is disabled
        if(this.getPref('disable_renaming')) return(name);
        // rename format
        var filename = '',
            item_type =  item.itemTypeID,
            format_default = item_type == Zotero.ItemTypes.getID('patent')
                ? this.getPref("renameFormat_patent")
                : this.getPref("renameFormat");
        format = typeof format !== 'undefined' ? format : format_default;
        // create the new filename from the selected item
        if (!this.getPref('useZoteroToRename')) {
            filename = this.Wildcards.replaceWildcard(item, format) || '';
            // Strip invalid characters (adopted from Zotero, modified to accept periods)
            filename = filename.replace(/[\/\\\?\*:|"<>]/g, '');
            // replace multiple blanks in filename with single blank & remove whitespace
            filename = Zotero.Utilities.trimInternal(filename);
            // remove periods, replace blanks with '_', convert to lower case
            if (this.getPref('removePeriods')) filename = filename.replace(/\./g, '');
            if (this.getPref('replace_blanks'))  filename = filename.replace(/ /g, '_');
            if (this.getPref('lower_case')) filename = filename.toLowerCase();
            // remove all the accents and other strange characters from filename
            if (this.getPref('removeDiacritics'))
                filename = Zotero.Utilities.removeDiacritics(filename);
        }
        // Use Zotero to get filename
        if (this.getPref('useZoteroToRename'))
            filename = Zotero.Attachments.getFileBaseNameFromItem(item);
        // Add user input to filename
        if(this.getPref('userInput') && !skipUserInput) filename = this.addUserInput(filename, name);
        // add filetype to filename
        var filetype = this.Utils.getFiletype(name);
        if(filetype != '') filename = filename + '.' + filetype;
        // valid zotero name
        filename = Zotero.File.getValidFileName(filename);
        // return
        return(filename);
    };

    /**
     * Format subfolder based on rule
     * @param  {Zotero.Item} item   Zotero item for metadata
     * @param  {string}      format Rule to construct subfolder with wildcards (e.g. '%j/%y')
     * @return {string}             Formatted subfolder such as 'Author/2010'
     */
    this.formatSubfolder = function(item, format) {
        if (format == '') return '';
        var subfolder = this.Wildcards.replaceWildcard(item, format) || '';
        // replace invalid characters
        return subfolder.split(/[\/\\]/)
            .map(s => s.trim())
            .map((s, i, parts) => (s == '' && i > 0 && i < parts.length - 1) ? 'undefined' : s)
            .filter(s => s != '' && s != '.' && s != '..')
            .filter(s => s != this.Wildcards.emptyCollectionPlaceholder)
            .map(s => Zotero.File.getValidFileName(s))
            .join(this.folderSep);
    };

    /**
     * Function to get location of file based on zotero item metadata
     * @param  {string}      basefolder Basefolder
     * @param  {Zotero.Item} item       Zotero item  for metadata
     * @param  {string}      format     Rule to construct subfolder with wildcards (e.g. '%j/%y')
     * @return {string}                 Folder path
     */
    this.getLocation = function(basefolder, item, format) {
        // check function arguments
        if (!item.isRegularItem()) throw new Error('getLocation: Not regular zotero item.');
        if (typeof basefolder != 'string') throw new Error("getLocation: 'basefolder' not string.");
        if (typeof format != 'string') throw new Error("getLocation: 'format' not string.");
        // combine folder and subfolder
        var subfolder = this.formatSubfolder(item, format);
        return this.Path.join(basefolder, subfolder);
    };

    /**
     * Move a linked attachment to a new location
     * (mostly adopted from `Zotero.Item.prototype.renameAttachmentFile` )
     * @param  {Zotero.Item} att       Zotero attachment to move
     * @param  {string}      location  Folder
     * @param  {string}      filename  Filename
     * @return {bool}                  Indicates whether successful
     */
    this.moveLinkedAttachmentFile = async function (att, location, filename) {
        if (!att.isAttachment() || att.attachmentLinkMode !== Zotero.Attachments.LINK_MODE_LINKED_FILE)
            return false;
        var origPath = await att.getFilePathAsync();
        if (!origPath) {
            Zotero.debug("Attachment file not found in moveLinkedAttachmentFile()", 2);
            return false;
        }
        try {
            filename = Zotero.File.getValidFileName(filename);
            var destPath = this.Path.join(location, filename);
            // Ignore if no change
            if (this.Path.normalize(origPath) === destPath) {
                Zotero.debug("Filename has not changed");
                return true;
            }
            destPath = await this.moveFile(origPath, destPath);
            await att.relinkAttachmentFile(destPath);
            return true;
        }
        catch (e) {
            Zotero.logError(e);
            return false;
        }
    };

    /**
     * Find a path that does not exist yet by adding a numerical suffix, and create the folder
     * @param  {String} sourcePath Normalized path of the source file.
     * @param  {String} destPath   Normalized path of the desired destination.
     * @return {String}            Available destination path (equals sourcePath if nothing to do)
     */
    var prepareDestination = async function(sourcePath, destPath) {
        var zz = Zotero.ZotFile,
            original = destPath,
            k = 2;
        // add suffix if target path exists
        while (await zz.Path.exists(destPath)) {
            destPath = zz.Utils.addNumericalSuffix(original, k);
            if (sourcePath == destPath) return sourcePath;
            k++;
            if (k > 999) throw new Error("ZotFile: '" + zz.Path.basename(destPath) + "' already exists.");
        }
        // create folder
        await IOUtils.makeDirectory(zz.Path.dirname(destPath), {createAncestors: true, ignoreExisting: true});
        return destPath;
    };

    /**
     * Move file to new location
     * @param  {String} sourcePath File to move.
     * @param  {String} target     Target directory or full path.
     * @param  {String} filename   Name of file.
     * @return {String}            Path to new location of file.
     */
    this.moveFile = async function (sourcePath, target, filename) {
        // check arguments
        if (!(await this.Path.exists(sourcePath))) throw new Error("Zotero.ZotFile.moveFile(): 'file' does not exists.");
        sourcePath = this.Path.normalize(sourcePath);
        var sourceDir = this.Path.dirname(sourcePath);
        // if target is '/' or '\', use file's parent directory
        if (target.trim() == this.folderSep) target = sourceDir;
        var destPath = filename === undefined ? this.Path.normalize(target) : this.Path.join(target, filename);
        // return if already at target
        if (sourcePath == destPath) return sourcePath;
        destPath = await prepareDestination(sourcePath, destPath);
        if (sourcePath == destPath) return sourcePath;
        // move file to new location
        await IOUtils.move(sourcePath, destPath, {noOverwrite: true});
        // sync the move with the rclone remote (if the folder is mapped)
        await this.Rclone.uploadFile(destPath);
        await this.Rclone.deleteFile(sourcePath);
        // delete empty folders after moving file
        await this.removeEmptyFolders(sourceDir);
        // return path to new location
        return destPath;
    };

    /**
     * Copy file to new location
     * @param  {String} sourcePath  File to copy.
     * @param  {String} target      Target directory or full path.
     * @param  {String} filename    Name of file.
     * @return {String}             Path to location of copied file.
     */
    this.copyFile = async function (sourcePath, target, filename) {
        // check arguments
        if (!(await this.Path.exists(sourcePath))) throw new Error("Zotero.ZotFile.copyFile(): 'file' does not exists.");
        sourcePath = this.Path.normalize(sourcePath);
        var destPath = filename === undefined ? this.Path.normalize(target) : this.Path.join(target, filename);
        if (sourcePath == destPath) return sourcePath;
        destPath = await prepareDestination(sourcePath, destPath);
        if (sourcePath == destPath) return sourcePath;
        // copy file
        await IOUtils.copy(sourcePath, destPath, {noOverwrite: true});
        // upload the copy to the rclone remote (if the folder is mapped)
        await this.Rclone.uploadFile(destPath);
        return destPath;
    };

    /**
     * Delete file or (empty) folder
     * @param  {nsIFile|String} file File or folder to be removed
     * @return {void}
     */
    this.removeFile = function(file) {
        file = Zotero.File.pathToFile(file);
        if (!file.exists()) return;
        try {
            // remove file
            if(!file.isDirectory()) {
                file.remove(false);
            }
            // ... for directories, remove them if no non-hidden files are inside
            else {
                var files = file.directoryEntries;
                while (files.hasMoreElements()) {
                    var f = files.getNext().QueryInterface(Components.interfaces.nsIFile);
                    if (!f.isHidden()) return;
                }
                file.remove(true);
            }
        }
        catch(err) {
            if(file.isDirectory()) this.infoWindow(this.ZFgetString('general.report'), this.ZFgetString('file.removeFolderFailed'));
        }
    };

    /**
     * Remove empty folders recursively within zotfile directories
     * @param  {String|nsIFile} folder Folder
     * @return {void}
     */
    this.removeEmptyFolders = async function (folder) {
        // Keep track of zotero's internal directory, current source and destination directory
        folder = Zotero.File.pathToFile(folder);
        var folders_zotfile = [this.Path.join(Zotero.DataDirectory.dir, 'storage')];
        var source_dir = await this.getSourceDir(false),
            dest_dir = this.getPref('dest_dir');
        if (source_dir) folders_zotfile.push(source_dir);
        if (dest_dir != '') folders_zotfile.push(dest_dir);
        folders_zotfile = folders_zotfile.map(path => this.Path.normalize(path));
        // Only delete folders if the file is located in any of the base folders
        if (!folders_zotfile.some(dir => folder.path.startsWith(dir))) return;
        // remove the original dir recursively until a non empty folder is found
        while(true) {
            // break if folder is not a directory or if it is the same directory as the source/zotero folder
            if (!folder.exists() || !folder.isDirectory() || folders_zotfile.indexOf(folder.path) !== -1)
                break;
            // remove file
            this.removeFile(folder);
            // Stop if the directory was not removed
            if (folder.exists()) break;
            // Try the parent of the current folder too
            folder = folder.parent;
            if (!folder) break;
        }
    };

    /**
     * Iterate over the valid files in a folder
     * @param  {string} path Path to directory
     * @return {array}       Array with nsIFile objects for each valid file in folder
     */
    var getValidFilesInFolder = function(path) {
        var zz = Zotero.ZotFile,
            dir = Zotero.File.pathToFile(path);
        if (!dir.exists() || !dir.isDirectory()) throw new Error("ZotFile: '" + path + "' is not a directory.");
        var pref_filetypes = zz.getPref('useFileTypes'),
            filetypes = zz.getPref('filetypes').split(',').map(s => s.trim().toLowerCase()),
            files = dir.directoryEntries,
            entries = [];
        while (files.hasMoreElements()) {
            // get next file
            let file = files.getNext().QueryInterface(Components.interfaces.nsIFile),
                filetype = zz.Utils.getFiletype(file.leafName).toLowerCase();
            // continue if directory, hidden file or certain file types
            try {
                if (file.isDirectory() || file.isHidden() || !file.isFile()) continue;
            }
            catch (e) {
                continue;
            }
            if (pref_filetypes && !filetypes.includes(filetype)) continue;
            // add file to array
            entries.push(file);
        }
        return entries;
    };

    /**
     * Get all valid files in folder
     * @param  {string} path Path to directory
     * @return {array}       Array with string paths for each valid file in folder
     */
    this.getFilesInFolder = function(path) {
        return getValidFilesInFolder(path).map(f => f.path);
    };

    /**
     * Get the last modified file from directory
     * @param  {string} path Path to directory
     * @return {string}      Path to last modified file in folder or undefined.
     */
    this.getLastFileInFolder = function(path) {
        var lastmod;
        for (let file of getValidFilesInFolder(path))
            if (!lastmod || file.lastModifiedTime > lastmod.lastModifiedTime) lastmod = file;
        return lastmod ? lastmod.path : undefined;
    };

    /**
     * Get zotfile's source directory
     * @param  {bool} message Show error message if invalid source directory
     * @return {string}       Path for directory or undefined if invalid directory
     */
    this.getSourceDir = async function (message) {
        var source_dir = this.Path.map(this.getPref('source_dir'));
        // valid source directory?
        if (source_dir == "" || !(await this.Path.exists(source_dir))) {
            if(message) this.infoWindow(this.ZFgetString('general.error'), this.ZFgetString('file.invalidSourceFolder'));
            return undefined;
        }
        return source_dir;
    };

    /**
     * Attach file to zotero items
     * @param  {Zotero.Item} item  Regular zotero item.
     * @param  {string}      path  Filepath.
     * @return {Zotero.Item}       Zotero attachment item
     */
    this.attachFile = async function (item, path) {
        if (!item.isRegularItem()) throw new Error("Zotero.ZotFile.attachFile(): 'item' is not a regular zotero item.");
        var att,
            options = {file: path, libraryID: item.libraryID, parentItemID: item.id, collections: undefined};
        // create imported attachment
        if (this.getPref('import') || item.library.libraryType != 'user') {
            this.excludeAutorenameKeys.push(item.key);
            att = await Zotero.Attachments.importFromFile(options);
            // rename attachment
            att = await this.renameAttachment(att);
            // remove file from source folder
            if (path != att.getFilePath() && (await this.Path.exists(path)))
                await IOUtils.remove(path);
        }
        // create linked attachment
        else {
            // get filename and location
            let filename = this.getFilename(item, this.Path.basename(path)),
                subfolder = this.getPref('subfolder') ? this.getPref('subfolderFormat') : '',
                location = this.getLocation(this.getPref('dest_dir'), item, subfolder);
            // move and rename file
            options.file = await this.moveFile(path, location, filename);
            // create zotero link to file
            this.excludeAutorenameKeys.push(item.key);
            att = await Zotero.Attachments.linkFromFile(options);
        }
        // return attachment item
        return att;
    };

    /**
     * Attach last file (or all files) from source directory
     * @return {void}
     */
    this.attachFileFromSourceDirectory = async function () {
        try {
            // get selected items
            var win = this.getMainWindow(),
                item = win.ZoteroPane.getSelectedItems()[0];
            if (!item) return;
            // if not top-level item, get parent
            item = !item.isTopLevelItem() ? Zotero.Items.get(item.parentItemID) : item;
            // check whether regular item
            if (!item.isRegularItem()) {
                this.handleErrors(this.ZFgetString('renaming.renameAttach.wrongItem'));
                return;
            }
            // get source dir
            var source_dir = await this.getSourceDir(false);
            // invalid source folder: ask user to choose one
            if (!source_dir) {
                source_dir = await this.chooseDirectory(win);
                if (!source_dir) {
                    this.infoWindow(this.ZFgetString('general.error'), this.ZFgetString('file.invalidSourceFolder'));
                    return;
                }
                this.setPref('source_dir', source_dir);
            }
            // custom location for linked files has to be valid
            if (!this.getPref('import') && item.library.libraryType == 'user' && !(await this.Path.exists(this.getPref('dest_dir')))) {
                this.handleErrors(this.ZFgetString('file.invalidDestFolder'));
                return;
            }
            // get files from source directory
            var paths = !this.getPref("allFiles") ? [this.getLastFileInFolder(source_dir)] : this.getFilesInFolder(source_dir);
            if (!paths[0]) {
                this.handleErrors(this.ZFgetString('renaming.renameAttach.noFileFound'));
                return;
            }
            // confirmation
            if (this.getPref("confirmation"))
                if(!this.confirm(this.ZFgetString('renaming.renameAttach.confirm', [this.Path.basename(paths[0])])))
                    return;
            // attach files
            var progress_win = this.progressWindow(this.ZFgetString('general.newAttachmentsAdded'));
            for (let i = 0; i < paths.length; i++) {
                let progress = new progress_win.ItemProgress('attachment-file', this.Path.basename(paths[i]));
                try {
                    let att = await this.attachFile(item, paths[i]);
                    progress.complete(att.getField('title'), this.getIcon(att));
                }
                catch (e) {
                    progress.setError();
                    this.messages_fatalError.push(e);
                }
            }
            progress_win.startCloseTimer(this.getPref("info_window_duration"));
            this.handleErrors();
        }
        catch (e) {
            this.messages_fatalError.push(e);
            this.handleErrors();
        }
    };

    /**
     * Transfer data from an attachment to the attachment that replaces it
     * (should stay in sync with Zotero.Attachments.convertLinkedFileToStoredFile())
     */
    var replaceAttachment = async function(att, attNew, item, data) {
        var zz = Zotero.ZotFile,
            win = zz.getMainWindow();
        // transfer tablet information
        zz.Tablet.moveInfo(att, attNew);
        // restore attachment data
        attNew.setRelations(data.relations);
        if (data.note != '') attNew.setNote(data.note);
        if (data.tags.length) attNew.setTags(data.tags);
        await attNew.saveTx();
        // select new attachment
        try {
            if (data.selection.includes(att.id)) {
                zz.Utils.arrayReplace(data.selection, att.id, attNew.id);
                win.ZoteroPane.itemsView.selectItems(data.selection);
            }
        }
        catch (e) {
            Zotero.logError(e);
        }
        // update links to attachment file in notes
        var notes = Zotero.Items.get(item.getNotes());
        for (let note of notes) {
            let content = note.getNote(),
                updated = content.replace(new RegExp('open-pdf/([\\w\\W\\d]{1,10})_' + att.key, 'g'), 'open-pdf/$1_' + attNew.key);
            if (updated == content) continue;
            note.setNote(updated);
            await note.saveTx();
        }
        // move child annotations and embedded-image attachments
        await Zotero.DB.executeTransaction(async function () {
            await Zotero.Items.moveChildItems(att, attNew);
        });
        // copy relations pointing to the old item
        await Zotero.Relations.copyObjectSubjectRelations(att, attNew);
        // transfer full-text item index
        try {
            await Zotero.DB.executeTransaction(async function () {
                await Zotero.Fulltext.transferItemIndex(att, attNew);
            });
        }
        catch (e) {
            Zotero.logError(e);
        }
    };

    /**
     * Rename attachment file based on parent item metadata.
     * @param  {Zotero.Item} att       Zotero attachment item.
     * @param  {bool}        imported  Create imported Zotero attachment.
     * @param  {bool}        rename    Rename attachment file.
     * @param  {string}      folder    Custom location if not imported attachment.
     * @param  {string}      subfolder Subfolder location if not important attachment
     * @param  {bool}        verbose   Notification about renaming.
     * @return {Zotero.Item}           Zotero item for renamed attachment.
     */
    this.renameAttachment = async function (att, imported, rename, folder, subfolder, verbose) {
        // default arguments
        imported = typeof imported !== 'undefined' ? imported : this.getPref('import');
        var subfolder_default = !imported && this.getPref('subfolder') ? this.getPref('subfolderFormat') : '';
        rename = typeof rename !== 'undefined' ? rename : true;
        folder = typeof folder !== 'undefined' ? folder : this.getPref('dest_dir');
        subfolder = typeof subfolder !== 'undefined' ? subfolder : subfolder_default;
        verbose = typeof verbose !== 'undefined' ? verbose : true;
        // check function arguments
        if (!att.isAttachment()) throw new Error('Zotero.ZotFile.renameAttachment(): No attachment item.');
        if (att.isTopLevelItem()) throw new Error('Zotero.ZotFile.renameAttachment(): Attachment is top-level item.');
        // set variables
        var win = this.getMainWindow(),
            linkmode = att.attachmentLinkMode,
            item = Zotero.Items.get(att.parentItemID),
            local = item.library.libraryType == 'user',
            path = await att.getFilePathAsync(),
            selection = [];
        try {
            selection = win.ZoteroPane.itemsView.getSelectedItems(true);
        }
        catch (e) {}
        var data = {
            note: att.getNote(),
            tags: att.getTags(),
            relations: att.getRelations(),
            selection: selection
        };
        if (!path) throw new Error('Zotero.ZotFile.renameAttachment(): Attachment file does not exists.');
        // only proceed if linked or imported attachment
        if(!att.isImportedAttachment() && linkmode != Zotero.Attachments.LINK_MODE_LINKED_FILE)
            return att;
        // get filename
        var filename = rename ? this.getFilename(item, att.attachmentFilename) : att.attachmentFilename;
        // (a) linked to imported attachment
        if (imported && linkmode == Zotero.Attachments.LINK_MODE_LINKED_FILE) {
            // attach file to selected Zotero item and return new attachment object
            let options = {file: path, libraryID: item.libraryID, parentItemID: item.id, collections: undefined, saveOptions: {skipSelect: true}};
            this.excludeAutorenameKeys.push(item.key);
            let attNew = await Zotero.Attachments.importFromFile(options);
            // rename file associated with attachment
            await attNew.renameAttachmentFile(filename);
            // change title of attachment item
            attNew.setField('title', filename);
            // restore and transfer attachment data
            await replaceAttachment(att, attNew, item, data);
            // erase old attachment, remove file and folder
            await att.eraseTx();
            await IOUtils.remove(path, {ignoreAbsent: true});
            await this.removeEmptyFolders(this.Path.dirname(path));
            // notification
            if (verbose) this.messages_report.push(this.ZFgetString('renaming.imported', [filename]));
            return attNew;
        }
        // (b) imported to imported attachment (or cloud library)
        if ((imported && att.isImportedAttachment()) || !local) {
            // rename file associated with attachment
            await att.renameAttachmentFile(filename);
            // change title of attachment item
            att.setField('title', filename);
            await att.saveTx();
            // notification
            if (verbose) this.messages_report.push(this.ZFgetString('renaming.imported', [filename]));
            return att;
        }
        // linked attachments require a valid custom location
        if (!folder || !(await this.Path.exists(folder)))
            throw new Error(this.ZFgetString('file.invalidDestFolder'));
        var location = this.getLocation(folder, item, subfolder);
        // (c) imported to linked attachment (only if library is local)
        if (att.isImportedAttachment() && !imported && local) {
            // move pdf file
            path = await this.moveFile(path, location, filename);
            if (!path) return att;
            // create linked attachment
            let options = {file: path, libraryID: item.libraryID, parentItemID: item.id, collections: undefined, saveOptions: {skipSelect: true}};
            this.excludeAutorenameKeys.push(item.key);
            let attNew = await Zotero.Attachments.linkFromFile(options);
            // change title of attachment item
            attNew.setField('title', filename);
            // restore and transfer attachment data
            await replaceAttachment(att, attNew, item, data);
            // erase old attachment
            await att.eraseTx();
            // notification and return
            if(verbose) this.messages_report.push(this.ZFgetString('renaming.linked', [filename]));
            return attNew;
        }
        // (d) linked to linked attachment (only if library is local)
        if (!att.isImportedAttachment() && !imported && local) {
            // relink attachment
            await this.moveLinkedAttachmentFile(att, location, filename);
            att.setField('title', filename);
            await att.saveTx();
            // notification
            if(verbose) this.messages_report.push(this.ZFgetString('renaming.linked', [filename]));
            return att;
        }
        return att;
    };

    /**
     * Rename select attachments
     * @return {void}
     */
    this.renameSelectedAttachments = async function () {
        try {
            // get selected attachments
            var atts = Zotero.Items.get(this.getSelectedAttachments())
                .filter(this.checkFileType);
            // confirm renaming
            if (this.getPref('confirmation_batch_ask') && atts.length >= this.getPref('confirmation_batch'))
                if(!this.confirm(this.ZFgetString('renaming.moveRename', [atts.length])))
                    return;
            // show infoWindow
            var progressWin = this.progressWindow(this.ZFgetString('renaming.renamed')),
                description = atts.length == 0;
            // rename attachments
            for (let i = 0; i < atts.length; i++) {
                // get attachment and add line to infoWindow
                let att = atts[i],
                    progress = new progressWin.ItemProgress(this.getIcon(att), att.getField('title'));
                // check attachment
                if(!(await att.fileExists()) || att.isTopLevelItem() || this.Tablet.getTabletStatus(att)) {
                    description = true;
                    progress.setError();
                    continue;
                }
                // Rename and move attachment
                try {
                    att = await this.renameAttachment(att);
                }
                catch (e) {
                    progress.setError();
                    if (e && e.name == 'UserAbortion') break;
                    this.messages_fatalError.push(e);
                    continue;
                }
                // update progress window
                progress.complete(att.attachmentFilename, this.getIcon(att));
            }
            // show messages and handle errors
            this.messages_report = [];
            if(description) progressWin.addDescription(this.ZFgetString('general.warning.skippedAtt.msg'));
            progressWin.startCloseTimer(this.getPref("info_window_duration"));
            this.handleErrors();
        }
        catch (e) {
            this.messages_fatalError.push(e);
            this.handleErrors();
        }
    };
};
