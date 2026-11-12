/**
 * Zotero.ZotFile.Tablet
 * Functions related to tablet features
 *
 * Information about attachments on the tablet (location, mode, modification time, subfolder)
 * is stored in the file 'zotfile-tablet.json' in the Zotero data directory. Earlier versions
 * of zotfile stored it as hidden data in the attachment note; that data is still read and is
 * moved to the new store whenever it is updated.
 */
Zotero.ZotFile.Tablet = new function() {

    var zz = Zotero.ZotFile,
        self = this;
    var store = {},
        storePath = null,
        storeWrite = Promise.resolve();

    Object.defineProperty(this, 'tag', {get: () => zz.getPref('tablet.tag')});
    Object.defineProperty(this, 'tagMod', {get: () => zz.getPref('tablet.tagModified')});

    // ===================== //
    // STORE FOR TABLET INFO //
    // ===================== //

    /**
     * Load information about tablet attachments (called once on startup)
     */
    this.loadStore = async function() {
        storePath = zz.Path.join(Zotero.DataDirectory.dir, 'zotfile-tablet.json');
        store = {};
        if (!(await zz.Path.exists(storePath))) return;
        try {
            var data = await IOUtils.readJSON(storePath);
            if (data && typeof data == 'object') store = data;
        }
        catch (e) {
            Zotero.logError(e);
            // keep the unreadable file instead of overwriting it
            try {
                await IOUtils.move(storePath, storePath + '.corrupt-' + Date.now());
            }
            catch (e2) {
                Zotero.logError(e2);
            }
        }
    };

    var saveStore = function() {
        if (!storePath) return storeWrite;
        var json = JSON.stringify(store, null, 1);
        storeWrite = storeWrite
            .then(() => IOUtils.writeUTF8(storePath, json, {tmpPath: storePath + '.tmp'}))
            .catch(e => Zotero.logError(e));
        return storeWrite;
    };

    /**
     * Wait until all changes are written to disk
     */
    this.flushStore = function() {
        return storeWrite;
    };

    var storeKey = function(att) {
        return att.libraryID + '/' + att.key;
    };

    /**
     * Get tablet data that previous versions of zotfile saved in the attachment note
     * @return {object} Object with doc (parsed note), node (element with data) and data, or null
     */
    var getLegacyInfo = function(att) {
        try {
            var content = att.getNote();
            if (!content || content.indexOf('lastmod') == -1) return null;
            var doc = new DOMParser().parseFromString(content.replace(/zotero:\/\//g, 'http://zotfile.com/'), 'text/html'),
                node = doc.querySelector('#zotfile-data');
            if (node === null) node = doc.querySelector('[title*="lastmod"][title*="projectFolder"]');
            if (node === null) return null;
            return {doc: doc, node: node, data: JSON.parse(node.getAttribute('title').replace(/&quot;/g, '"'))};
        }
        catch (e) {
            return null;
        }
    };

    /**
     * Remove tablet data from attachment note. A separate save() is required to update the database.
     */
    var removeLegacyInfo = function(att, legacy) {
        legacy = legacy || getLegacyInfo(att);
        if (!legacy) return;
        legacy.node.remove();
        var content = legacy.doc.body.innerHTML.replace(/http:\/\/zotfile.com\//g, 'zotero://');
        att.setNote(content.trim());
    };

    var getData = function(att) {
        var key = storeKey(att);
        if (key in store) return store[key];
        var legacy = getLegacyInfo(att);
        return legacy ? legacy.data : null;
    };

    /**
     * Get tablet information for attachment
     * @param  {Zotero.Item} att Zotero attachment item
     * @param  {string}      key 'mode', 'location', 'lastmod' or 'projectFolder'
     * @return {string|int}      Value or '' if not available
     */
    this.getInfo = function(att, key) {
        try {
            var data = getData(att),
                value = data && key in data ? data[key] : undefined;
            if (value === undefined || value === null) return '';
            // for location tag: replace [BaseFolder] with destination folder
            if(key == 'location') value = value.replace('[BaseFolder]', zz.getPref('tablet.dest_dir'));
            // for location and projectFolder tag: correct window/mac file system
            if(['location', 'projectFolder'].includes(key) && Zotero.isWin) value = value.replace(/\//g, '\\');
            if(['location', 'projectFolder'].includes(key) && !Zotero.isWin) value = value.replace(/\\/g, '/');
            return value;
        }
        catch (err) {
            return '';
        }
    };

    /**
     * Add tablet information for attachment. If the attachment has data from a previous
     * version in its note, a separate save() is required to update the database.
     * @param {Zotero.Item} att   Zotero attachment item.
     * @param {Object}      data  Object with data to save
     */
    this.addInfo = function(att, data) {
        var key = storeKey(att),
            current = {};
        if (key in store) current = store[key];
        else {
            let legacy = getLegacyInfo(att);
            if (legacy) {
                current = legacy.data;
                removeLegacyInfo(att, legacy);
            }
        }
        data = Object.assign({}, data);
        // for location tag: replace destination folder with [BaseFolder]
        if('location' in data && zz.getPref('tablet.dest_dir_relativePath'))
            data.location = data.location.replace(zz.Path.normalize(zz.getPref('tablet.dest_dir')), '[BaseFolder]');
        store[key] = Object.assign({}, current, data);
        saveStore();
    };

    /**
     * Remove tablet information for attachment. A separate save() is required to update the database.
     * @param {Zotero.Item} att Zotero attachment item.
     */
    this.clearInfo = function(att) {
        var key = storeKey(att);
        if (key in store) {
            delete store[key];
            saveStore();
        }
        removeLegacyInfo(att);
    };

    /**
     * Transfer tablet information to the attachment item that replaces another one
     */
    this.moveInfo = function(att, attNew) {
        var key = storeKey(att);
        if (!(key in store) || att.id == attNew.id) return;
        store[storeKey(attNew)] = store[key];
        delete store[key];
        saveStore();
    };

    /**
     * Modification time of file in milliseconds
     */
    var getModificationTime = async function(path) {
        return Math.floor((await IOUtils.stat(path)).lastModified);
    };

    // ==== //
    // TAGS //
    // ==== //

    /**
     * Add tablet tag to attachment and parent item. A separate save() for attachment and parent item
     *     is required to update the database.
     * @param {Zotero.Item} att Zotero attachment item
     * @param {string}      tag Name of tag
     * @return {void}
     */
    this.addTabletTag = function (att, tag) {
        var item = Zotero.Items.get(att.parentItemID);
        var tag_remove = (tag == self.tag) ? self.tagMod : self.tag;
        // add tag to parent and attachment
        att.addTag(tag);
        item.addTag(tag);
        // remove other tag from parent and attachment
        att.removeTag(tag_remove);
        if (item.hasTag(tag_remove)) {
            var atts = Zotero.Items.get(item.getAttachments());
            if (!atts.some(att => att.hasTag(tag_remove)))
                item.removeTag(tag_remove);
        }
    };

    /**
     * Remove tablet tag from attachment and parent item
     * @param  {Zotero.Item} att Zotero attachment item
     * @param  {string}      tag Name of tag to remove
     * @return {void}
     */
    this.removeTabletTag = function(att, tag) {
        // remove from attachment
        att.removeTag(tag);
        // remove from parent item
        var item = Zotero.Items.get(att.parentItemID);
        if(item.hasTag(tag)) {
            var atts = Zotero.Items.get(item.getAttachments());
            if(!atts.some(att => att.hasTag(tag)))
                item.removeTag(tag);
        }
    };

    this.createSavedSearch = async function(which) {
        if(which == 'tablet' || which == 'both') {
            let search = new Zotero.Search();
            search.libraryID = Zotero.Libraries.userLibraryID;
            search.addCondition('tag', 'contains', self.tag);
            search.addCondition('includeParentsAndChildren', 'true');
            search.addCondition('noChildren', 'true');
            search.name = 'Tablet Files';
            await search.saveTx();
        }
        if(which == 'tablet_modified' || which == 'both') {
            let search = new Zotero.Search();
            search.libraryID = Zotero.Libraries.userLibraryID;
            search.addCondition('tag', 'is', self.tagMod);
            search.name = 'Tablet Files (modified)';
            await search.saveTx();
        }
    };

    // ====== //
    // STATUS //
    // ====== //

    this.getTabletStatus = function(att) {
        if(!att) return false;
        return att.isAttachment() && (att.hasTag(self.tag) || att.hasTag(self.tagMod));
    };

    /**
     * Was the tablet file modified?
     * @param  {Zotero.Item} att Zotero attachment item.
     * @return {bool}            Was the tablet file modified?
     */
    this.getTabletStatusModified = async function (att) {
        if (!self.getTabletStatus(att))
            return false;
        var path = await self.getTabletFilePath(att, false);
        if (!path) return false;
        // compare saved modification time with modification time of tablet file
        var lastmod_tablet = self.getInfo(att, 'lastmod'),
            lastmod_file = await getModificationTime(path);
        return lastmod_tablet !== '' && lastmod_file != parseInt(lastmod_tablet, 10);
    };

    /**
     * Get the path to the tablet file
     * @param  {Zotero.Item} att     Zotero attachment item.
     * @param  {bool}        verbose Show error message if file does not exists
     * @return {string}              Path to file on tablet or false if file does not exists.
     */
    this.getTabletFilePath = async function (att, verbose) {
        verbose = typeof verbose !== 'undefined' ? verbose : true;
        // foreground mode
        if(self.getInfo(att, 'mode') == 2)
            return await att.getFilePathAsync();
        // background mode
        var path = self.getInfo(att, 'location');
        if(!(await zz.Path.exists(path))) {
            if (verbose) zz.infoWindow('ZotFile Error', 'The file "' + path + '" does not exist.');
            return false;
        }
        return path;
    };

    this.getTabletLocationFile = function(subfolder) {
        if(subfolder == null) subfolder = '';
        return zz.Path.join(zz.getPref('tablet.dest_dir'), subfolder);
    };

    this.getAttachmentsOnTablet = async function (subfolder) {
        // search for attachments with tag
        var search = new Zotero.Search();
        search.libraryID = Zotero.Libraries.userLibraryID;
        search.addCondition('itemType', 'is', 'attachment');
        search.addCondition('tag', 'contains', self.tag);
        var search_results = await search.search();
        var atts = Zotero.Items.get(search_results)
            .filter(item => item.isAttachment() && !item.isTopLevelItem());
        // show warning if no information is available
        if(zz.getPref('tablet.showwarning'))
            atts.filter(att => self.getInfo(att, 'mode') === '')
                .forEach(att => zz.infoWindow(zz.ZFgetString('general.warning'), zz.ZFgetString('tablet.attachmentNoteMissing') + ' (' + att.key + ')'));
        // return attachments on tablet
        return atts.filter(att => self.getInfo(att, 'mode') !== '')
            .filter(att => subfolder === undefined || self.getInfo(att, 'projectFolder').toLowerCase() == subfolder.toLowerCase());
    };

    this.getModifiedAttachmentsOnTablet = async function (subfolder) {
        var atts = await self.getAttachmentsOnTablet(subfolder);
        return zz.Utils.asyncFilter(atts, att => self.getTabletStatusModified(att));
    };

    /**
     * Move attachments on the tablet to a different subfolder
     */
    this.setTabletFolder = async function (atts, projectFolder) {
        projectFolder = typeof projectFolder !== 'undefined' ? projectFolder : '';
        var tablet_folder = zz.Path.join(zz.getPref('tablet.dest_dir'), projectFolder),
            tablet_subfolder = zz.getPref('tablet.subfolder') ? zz.getPref('tablet.subfolderFormat') : '';
        atts = atts.filter(att => !att.isTopLevelItem());
        // show infoWindow
        var loc = (projectFolder !== '') ? ("'..." + projectFolder + "'.") : zz.ZFgetString('tablet.baseFolder');
        var progressWin = zz.progressWindow(zz.ZFgetString('tablet.movedAttachments', [loc]));
        // iterate over attachments
        for (let att of atts) {
            let progress = new progressWin.ItemProgress(zz.getIcon(att), att.getField('title'));
            try {
                let item = Zotero.Items.get(att.parentItemID),
                    path = await self.getTabletFilePath(att),
                    att_mode = self.getInfo(att, 'mode');
                if (!path) throw new Error('Tablet file not found.');
                let folder = zz.getLocation(tablet_folder, item, tablet_subfolder),
                    pathNew = zz.Path.join(folder, zz.Path.basename(path)),
                    time_saved  = parseInt(self.getInfo(att, 'lastmod'), 10),
                    time_tablet = await getModificationTime(path);
                // update tablet folder (background mode)
                if(att_mode == 1)
                    pathNew = await zz.moveFile(path, pathNew);
                // update tablet folder (foreground mode)
                if(att_mode == 2) {
                    await zz.moveLinkedAttachmentFile(att, folder, zz.Path.basename(path));
                    pathNew = await att.getFilePathAsync();
                }
                // update tablet information
                self.addInfo(att, {
                    'lastmod': time_saved == time_tablet ? await getModificationTime(pathNew) : time_saved,
                    'location': pathNew,
                    'projectFolder': projectFolder
                });
                await att.saveTx();
                // update progress window
                progress.complete(att.attachmentFilename, zz.getIcon(att));
            }
            catch(e) {
                progress.setError();
                zz.messages_fatalError.push(e);
            }
        }
        // show messages and handle errors
        progressWin.startCloseTimer(zz.getPref("info_window_duration"));
        zz.handleErrors();
    };

    /**
     * Is a saved search for tablet files selected?
     */
    this.checkSelectedSearch = function() {
        try {
            var pane = zz.getMainWindow().ZoteroPane,
                // Zotero 10 allows to select multiple rows
                searches = pane.getSelectedSavedSearches
                    ? pane.getSelectedSavedSearches()
                    : [pane.getSelectedSavedSearch()];
            return searches.filter(search => search).some(function(search) {
                var conditions = search.getConditions();
                return Object.keys(conditions).some(key => conditions[key].condition == 'tag' &&
                    [self.tag, self.tagMod].includes(conditions[key].value));
            });
        }
        catch (e) {
            return false;
        }
    };

    /**
     * Tag attachments that were modified on the tablet (when a tablet saved search is selected)
     */
    this.updateModifiedAttachmentsSearch = async function () {
        try {
            if (!zz.getPref('tablet') || !self.checkSelectedSearch()) return;
            // add tag for modified tablet item and remove tablet tag
            var atts = await self.getModifiedAttachmentsOnTablet();
            atts = atts.filter(att => !att.hasTag(self.tagMod));
            if (atts.length == 0) return;
            await Zotero.DB.executeTransaction(async function () {
                for (let att of atts) {
                    self.addTabletTag(att, self.tagMod);
                    await att.save();
                    await Zotero.Items.get(att.parentItemID).save();
                }
            });
        }
        catch (e) {
            Zotero.logError(e);
        }
    };

    // ============== //
    // SEND TO TABLET //
    // ============== //

    /**
     * Send attachment to tablet folder
     * @param  {Zotero.Item} att            Zotero attachment item
     * @param  {string}      project_folder Subfolder in tablet folder
     * @param  {bool}        verbose        Add report message
     * @return {Zotero.Item}                Zotero attachment item
     */
    this.sendAttachmentToTablet = async function (att, project_folder, verbose) {
        verbose = (typeof verbose == 'undefined') ? true : verbose;
        project_folder = project_folder || '';
        // valid attachment
        if (!att.isAttachment() || att.isTopLevelItem())
            throw new Error("Zotero.ZotFile.Tablet.sendAttachmentToTablet(): att is not a Zotero attachment");
        if (!(await att.fileExists()) || !zz.checkFileType(att)) return att;
        var item = Zotero.Items.get(att.parentItemID),
            path = await att.getFilePathAsync(),
            tablet_status = self.getTabletStatus(att);
        // settings
        var tablet_mode = zz.getPref('tablet.mode'),
            tablet_rename = zz.getPref('tablet.rename'),
            tablet_dest = zz.Path.join(zz.getPref('tablet.dest_dir'), project_folder),
            tablet_subfolder = zz.getPref('tablet.subfolder') ? zz.getPref('tablet.subfolderFormat') : '';
        // background mode: Rename and Move Attachment
        if (tablet_mode == 1) {
            // change name of attachment file
            if (tablet_rename)  {
                let filename = zz.getFilename(item, att.attachmentFilename);
                if(filename != att.attachmentFilename) {
                    await att.renameAttachmentFile(filename);
                    att.setField('title', filename);
                    await att.saveTx();
                    path = await att.getFilePathAsync();
                }
            }
            // create copy of file on tablet
            let folder = zz.getLocation(tablet_dest, item, tablet_subfolder);
            if (!tablet_status) path = await zz.copyFile(path, folder, att.attachmentFilename);
            if (tablet_status) {
                let path_tablet = await self.getTabletFilePath(att, false);
                if(path_tablet) {
                    path = await zz.moveFile(path_tablet, folder, att.attachmentFilename);
                }
                // file on tablet not found: create a new copy
                else {
                    path = await zz.copyFile(path, folder, att.attachmentFilename);
                }
            }
        }
        // foreground mode: Rename and Move Attachment
        if(tablet_mode == 2) {
            att = await zz.renameAttachment(att, false, tablet_rename, tablet_dest, tablet_subfolder, false);
            path = await att.getFilePathAsync();
        }
        // add info (date of modification to attachment, location, and mode)
        self.addInfo(att, {
            'lastmod': await getModificationTime(path),
            'mode': tablet_mode,
            'location': path,
            'projectFolder': project_folder
        });
        // add tags
        if (!tablet_status) {
            self.addTabletTag(att, self.tag);
            if (zz.getPref('tablet.tagParentPush')) item.addTag(zz.getPref('tablet.tagParentPush_tag'));
            await item.saveTx();
        }
        await att.saveTx();
        // notification
        if(verbose) zz.messages_report.push("'" + zz.Path.basename(path) + "'");
        return att;
    };

    /**
     * Send selected Zotero attachments to tablet
     * @param  {string} project_folder Subfolder in tablet folder (optional)
     * @return {void}
     */
    this.sendSelectedAttachmentsToTablet = async function (project_folder) {
        try {
            project_folder = project_folder || '';
            // get selected attachments
            var atts = Zotero.Items.get(zz.getSelectedAttachments())
                .filter(zz.checkFileType);
            // confirm
            var atts_tablet = await zz.Utils.asyncFilter(atts, async att =>
                    self.getTabletStatus(att) && (await self.getTabletFilePath(att, false))),
                pref_repush = !zz.getPref('tablet.confirmRepush');
            if (zz.getPref('confirmation_batch_ask') && atts.length >= zz.getPref('confirmation_batch'))
                if(!zz.confirm(zz.ZFgetString('tablet.sendAttachments', [atts.length]))) return;
            if (!pref_repush && (atts_tablet.length > 0))
                pref_repush = zz.confirm(zz.ZFgetString('tablet.replaceAttachAlready', [atts_tablet.length]));
            // show infoWindow
            var progressWin = zz.progressWindow(zz.ZFgetString('tablet.AttsMoved')),
                description = atts.length == 0;
            // iterate through attachments
            for (let att of atts) {
                let path_tablet = await self.getTabletFilePath(att, false);
                if(self.getTabletStatus(att) && path_tablet && !pref_repush) {
                    description = true;
                    continue;
                }
                // get attachment and add line to infoWindow
                let att_mode = self.getInfo(att, 'mode'),
                    progress = new progressWin.ItemProgress(zz.getIcon(att), att.getField('title'));
                // check attachment
                if (!(await att.fileExists()) || att.isTopLevelItem()) {
                    description = true;
                    progress.setError();
                    continue;
                }
                try {
                    // First remove from tablet if mode has changed or tablet file was moved
                    if(self.getTabletStatus(att) && (att_mode != zz.getPref('tablet.mode') || !path_tablet))
                        att = await self.getAttachmentFromTablet(att, true);
                    // send to tablet
                    att = await self.sendAttachmentToTablet(att, project_folder, false);
                    // update progress window
                    progress.complete(att.attachmentFilename, zz.getIcon(att));
                }
                catch (e) {
                    progress.setError();
                    zz.messages_fatalError.push(e);
                }
            }
            // show messages and handle errors
            zz.messages_report = [];
            if(description) progressWin.addDescription(zz.ZFgetString('general.warning.skippedAtt.msg'));
            progressWin.startCloseTimer(zz.getPref('info_window_duration'));
            zz.handleErrors();
        }
        catch (e) {
            zz.messages_fatalError.push(e);
            zz.handleErrors();
        }
    };

    /**
     * Update modification time and file in Zotero for the selected attachments on the tablet
     */
    this.updateSelectedTabletAttachments = async function () {
        try {
            // get selected attachments, filter for tablet
            var atts = Zotero.Items.get(zz.getSelectedAttachments())
                .filter(self.getTabletStatus)
                .filter(zz.checkFileType);
            // show notification
            var progressWin = zz.progressWindow('ZotFile: Update Modification Time'),
                description = atts.length == 0;
            // iterate through selected attachments
            for (let att of atts) {
                let item = Zotero.Items.get(att.parentItemID),
                    path = await self.getTabletFilePath(att),
                    progress = new progressWin.ItemProgress(zz.getIcon(att), att.getField('title')),
                    att_mode = self.getInfo(att, 'mode');
                if(!path || att.isTopLevelItem()) {
                    description = true;
                    progress.setError();
                    continue;
                }
                try {
                    if (await self.getTabletStatusModified(att)) {
                        // update status (foreground mode)
                        if(att_mode == 2) {
                            self.addInfo(att, {'lastmod': await getModificationTime(path)});
                            self.addTabletTag(att, self.tag);
                            await att.saveTx();
                            await item.saveTx();
                        }
                        // update status (background mode)
                        if(att_mode == 1) {
                            let project_folder = self.getInfo(att, 'projectFolder');
                            // first get from tablet
                            att = await self.getAttachmentFromTablet(att, true);
                            // now send back to reader
                            att = await self.sendAttachmentToTablet(att, project_folder, false);
                        }
                    }
                    // update progress window
                    progress.complete(att.attachmentFilename, zz.getIcon(att));
                }
                catch (e) {
                    progress.setError();
                    zz.messages_fatalError.push(e);
                }
            }
            // show messages and handle errors
            zz.messages_report = [];
            if(description) progressWin.addDescription(zz.ZFgetString('general.warning.skippedAtt.msg'));
            progressWin.startCloseTimer(zz.getPref('info_window_duration'));
            zz.handleErrors();
        }
        catch (e) {
            zz.messages_fatalError.push(e);
            zz.handleErrors();
        }
    };

    // =============== //
    // GET FROM TABLET //
    // =============== //

    /**
     * Get attachment from tablet
     * @param  {Zotero.Item} att         Zotero attachment item
     * @param  {bool}        fake_remove Keep tablet tag and information (the attachment is sent again right away)
     * @return {Zotero.Item}             Zotero attachment item
     */
    this.getAttachmentFromTablet = async function (att, fake_remove) {
        var item = Zotero.Items.get(att.parentItemID),
            tablet_status = 1,
            item_pulled = false,
            att_deleted = false,
            att_mode = self.getInfo(att, 'mode'),
            attSubfolder = String(self.getInfo(att, 'projectFolder')).trim();
        // get files
        var path_zotero = await att.getFilePathAsync(),
            path_tablet = await self.getTabletFilePath(att, false);
        if (!path_tablet) {
            // clear tablet tag and info from att and parent item
            self.removeTabletTag(att, self.tag);
            self.removeTabletTag(att, self.tagMod);
            self.clearInfo(att);
            await att.saveTx();
            await item.saveTx();
            if (!fake_remove)
                zz.infoWindow('ZotFile Warning', 'The tablet file "' + att.attachmentFilename + '" was manually moved and does not exist.');
            return att;
        }
        var tablet_folder = zz.Path.dirname(path_tablet);
        // get modification times for files
        var time_tablet = await getModificationTime(path_tablet),
            time_saved  = parseInt(self.getInfo(att, 'lastmod'), 10),
            time_zotero = path_zotero ? await getModificationTime(path_zotero) : 0;
        // background mode
        if(att_mode == 1) {
            if (!path_zotero) throw new Error("The file of the attachment '" + att.getField('title') + "' does not exist in Zotero.");
            // set options
            if (time_tablet > time_saved  && time_zotero <= time_saved) tablet_status = 0;
            if (time_tablet <= time_saved && time_zotero <= time_saved) tablet_status = 2;
            if (time_tablet <= time_saved && time_zotero > time_saved) tablet_status = 2;
            if (time_tablet > time_saved  && time_zotero > time_saved) tablet_status = 1;
            // if attachment gets replaced
            if (!zz.getPref('tablet.storeCopyOfFile')) {
                // prompt if both file have been modified
                if (tablet_status == 1) {
                    tablet_status = zz.promptUser(zz.ZFgetString('tablet.fileConflict', [att.attachmentFilename]),
                        zz.ZFgetString('tablet.fileConflict.replaceZ'),
                        zz.ZFgetString('general.cancel'),
                        zz.ZFgetString('tablet.fileConflict.removeT'));
                    // att_deleted is true to display a special message when the tablet file is removed without being sent back to Zotero
                    if (tablet_status == 2) att_deleted = true;
                }
                // replace zotero file
                if(tablet_status == 0) {
                    await IOUtils.move(path_tablet, path_zotero);
                    item_pulled = true;
                }
            }
            // if saving a copy of the file as a new attachment with suffix and tablet file was modified
            if (zz.getPref('tablet.storeCopyOfFile') && tablet_status != 2)  {
                let filename = zz.Utils.addSuffix(zz.Path.basename(path_zotero), zz.getPref('tablet.storeCopyOfFile_suffix'));
                zz.excludeAutorenameKeys.push(item.key);
                // add linked attachment
                if (item.library.libraryType == 'user' && !zz.getPref('import')) {
                    let path_copied = await zz.moveFile(path_tablet, zz.Path.dirname(path_zotero), filename);
                    await Zotero.Attachments.linkFromFile({file: path_copied, libraryID: item.libraryID, parentItemID: item.id, collections: undefined});
                    item_pulled = true;
                }
                // imports attachment
                else {
                    let att_new = await Zotero.Attachments.importFromFile({file: path_tablet, libraryID: item.libraryID, parentItemID: item.id, collections: undefined});
                    // rename file associated with attachment
                    await att_new.renameAttachmentFile(filename);
                    // change title of attachment item
                    att_new.setField('title', filename);
                    await att_new.saveTx();
                    // remove file on tablet
                    await IOUtils.remove(path_tablet, {ignoreAbsent: true});
                    item_pulled = true;
                }
            }
            // Pull without replacement (i.e. remove file on tablet)
            if(tablet_status == 2) {
                await IOUtils.remove(path_tablet, {ignoreAbsent: true});
                item_pulled = true;
            }
        }
        // foreground mode
        if(att_mode == 2) {
            // rename and move attachment
            let subfolder = !zz.getPref('import') && zz.getPref('subfolder') ? zz.getPref('subfolderFormat') : '';
            att = await zz.renameAttachment(att, zz.getPref('import'), zz.getPref('tablet.rename'),
                            zz.getPref('dest_dir'), subfolder, false);
            // finish up
            item_pulled = true;
            tablet_status = time_zotero > time_saved ? 0 : 2;
        }
        // remove subfolder if empty
        if (attSubfolder != "" && tablet_folder != zz.Path.normalize(zz.getPref('tablet.dest_dir')))
            zz.removeFile(tablet_folder);
        // post-processing if attachment has been removed & it's not a fake-pull
        if (item_pulled && !fake_remove) {
            // remove tag from attachment and parent item
            self.removeTabletTag(att, self.tag);
            // clear tablet information
            self.clearInfo(att);
            // remove tag from parent item
            let tag_parent = zz.getPref('tablet.tagParentPush_tag');
            if(item.hasTag(tag_parent)) item.removeTag(tag_parent);
            // add tag to parent item
            if (zz.getPref('tablet.tagParentPull'))
                item.addTag(zz.getPref('tablet.tagParentPull_tag'));
            // notification (different message if the tablet file was removed without being sent back to Zotero)
            zz.messages_report.push("'" + att.attachmentFilename + "' " + (att_deleted ? zz.ZFgetString('tablet.attsDel') : ''));
        }
        // remove modified tag from attachment
        if (item_pulled) self.removeTabletTag(att, self.tagMod);
        await att.saveTx();
        await item.saveTx();
        return att;
    };

    this.getSelectedAttachmentsFromTablet = async function () {
        try {
            // get selected attachments, filter for tablet
            var atts = Zotero.Items.get(zz.getSelectedAttachments())
                .filter(self.getTabletStatus)
                .filter(zz.checkFileType);
            // confirm
            if (zz.getPref("confirmation_batch_ask") && atts.length >= zz.getPref("confirmation_batch"))
                if(!zz.confirm(zz.ZFgetString('tablet.getAttachments', [atts.length])))
                    return;
            // show notification
            var progressWin = zz.progressWindow(zz.ZFgetString('tablet.AttsGot')),
                description = atts.length == 0;
            // iterate through attachments
            for (let att of atts) {
                let progress = new progressWin.ItemProgress(zz.getIcon(att), att.getField('title'));
                // check attachment
                if(att.isTopLevelItem()) {
                    description = true;
                    progress.setError();
                    continue;
                }
                try {
                    // get attachment from tablet
                    att = await self.getAttachmentFromTablet(att, false);
                    // update progress window
                    progress.complete(att.attachmentFilename, zz.getIcon(att));
                }
                catch (e) {
                    progress.setError();
                    zz.messages_fatalError.push(e);
                }
            }
            // show messages and handle errors
            zz.messages_report = [];
            if(description) progressWin.addDescription(zz.ZFgetString('general.warning.skippedAtt.msg'));
            progressWin.startCloseTimer(zz.getPref("info_window_duration"));
            zz.handleErrors();
        }
        catch (e) {
            zz.messages_fatalError.push(e);
            zz.handleErrors();
        }
    };
};
