/**
 * Zotero.ZotFile.UI
 * Functions to add the zotfile menu items to Zotero's main window(s)
 */

Zotero.ZotFile.UI = new function() {

    var zz = Zotero.ZotFile;
    // elements and listeners added to each window (for clean removal)
    var windows = new Map();
    var MAX_SUBFOLDERS = 15;

    var setHidden = function(elem, hidden) {
        if (hidden) elem.setAttribute('hidden', 'true');
        else elem.removeAttribute('hidden');
    };

    var setDisabled = function(elem, disabled) {
        if (disabled) elem.setAttribute('disabled', 'true');
        else elem.removeAttribute('disabled');
    };

    var createElement = function(doc, tag, attributes, onCommand) {
        var elem = doc.createXULElement(tag);
        for (let name in attributes) elem.setAttribute(name, attributes[name]);
        if (onCommand) elem.addEventListener('command', function(event) {
            event.stopPropagation();
            onCommand();
        });
        return elem;
    };

    /**
     * Menu items of the 'Manage Attachments' submenu for the current selection
     * @param  {Window} win Zotero main window
     * @return {array}      Array with objects describing the menu items: {label, tooltip, disabled, command},
     *                      {separator: true} or {label, header: true}
     */
    this.getMenuItems = function(win) {
        var Tablet = zz.Tablet,
            items = win.ZoteroPane.getSelectedItems(),
            atts = Zotero.Items.get(zz.getSelectedAttachments()),
            menu = [];
        var warning = label => ({label: label, disabled: true});
        // rename
        menu.push({
            id: 'id-zotfile-rename',
            label: zz.ZFgetString('ui.renameSelectedAttachments.label'),
            tooltip: zz.ZFgetString('ui.renameSelectedAttachments.tooltiptext'),
            disabled: atts.length == 0,
            command: () => zz.renameSelectedAttachments()
        });
        if (atts.length == 0) menu.push(warning(zz.ZFgetString('menu.itemHasNoAtts')));
        // tablet
        if (zz.getPref('tablet') && atts.length > 0) {
            menu.push({separator: true});
            let dest_dir = zz.Path.normalize(zz.getPref('tablet.dest_dir')),
                valid_destination = false,
                group_library = items.some(item => item.libraryID != Zotero.Libraries.userLibraryID),
                on_tablet = atts.some(att => Tablet.getTabletStatus(att));
            try {
                valid_destination = dest_dir != '' && Zotero.File.pathToFile(dest_dir).exists();
            }
            catch (e) {}
            if (!valid_destination) menu.push(warning(zz.ZFgetString('menu.invalidTabletLocation')));
            else if (group_library) menu.push(warning(zz.ZFgetString('menu.itemIsInGroupLibrary')));
            else {
                menu.push({
                    id: 'id-zotfile-send-tablet',
                    label: zz.ZFgetString('ui.send-to-tablet'),
                    tooltip: zz.ZFgetString('menu.sendAttToBaseFolder', [dest_dir]),
                    command: () => Tablet.sendSelectedAttachmentsToTablet()
                });
                if (Tablet.checkSelectedSearch() || zz.getPref('tablet.updateAlwaysShow')) menu.push({
                    label: zz.ZFgetString('ui.update-file-modification-time'),
                    tooltip: zz.ZFgetString('ui.sync-attachment-file'),
                    disabled: !on_tablet,
                    command: () => Tablet.updateSelectedTabletAttachments()
                });
                menu.push({
                    id: 'id-zotfile-get-tablet',
                    label: zz.ZFgetString('ui.get-from-tablet'),
                    tooltip: zz.ZFgetString('ui.get-attachment-file-from-tablet'),
                    disabled: !on_tablet,
                    command: () => Tablet.getSelectedAttachmentsFromTablet()
                });
                // subfolders
                let mode = zz.getPref('tablet.projectFolders'),
                    folders = [];
                // subfolders based on collections of the first selected item
                if (mode == 1) {
                    let item = items[0];
                    if (item.isAttachment() && item.parentItemID) item = Zotero.Items.get(item.parentItemID);
                    folders = zz.Utils.getCollectionPathsOfItem(item)
                        .filter(path => path != '')
                        .sort()
                        .map(path => ({label: path, path: path}));
                }
                // user defined subfolders
                if (mode == 2) {
                    try {
                        folders = JSON.parse(zz.getPref('tablet.subfolders'));
                    }
                    catch (e) {}
                }
                if (mode == 1 || mode == 2) {
                    menu.push({separator: true});
                    menu.push({label: zz.ZFgetString('ui.send-to-subfolder-on-tablet'), header: true});
                    if (folders.length == 0)
                        menu.push(warning(zz.ZFgetString(mode == 1 ? 'menu.itemIsInNoCollection' : 'menu.noSubfoldersDefined')));
                    for (let folder of folders.slice(0, MAX_SUBFOLDERS)) menu.push({
                        label: folder.label,
                        tooltip: zz.ZFgetString('menu.sendAttToSubfolder', [folder.path]),
                        command: () => Tablet.sendSelectedAttachmentsToTablet(folder.path)
                    });
                }
                if (mode == 2) {
                    menu.push({separator: true});
                    menu.push({
                        label: zz.ZFgetString('ui.change-subfolders'),
                        tooltip: zz.ZFgetString('ui.add-and-delete-subfolders'),
                        command: () => zz.openPreferenceWindow('#zotfile-tablet-section')
                    });
                }
            }
        }
        // preferences
        menu.push({separator: true});
        menu.push({
            id: 'id-zotfile-menu-options',
            label: zz.ZFgetString('ui.zotfile-options.label'),
            command: () => zz.openPreferenceWindow()
        });
        return menu;
    };

    /**
     * (Re-)build the 'Manage Attachments' submenu for the current selection
     */
    var buildMenu = function(win, popup) {
        var doc = win.document;
        while (popup.firstChild) popup.firstChild.remove();
        for (let item of zz.UI.getMenuItems(win)) {
            if (item.separator) {
                popup.appendChild(createElement(doc, 'menuseparator', {}));
                continue;
            }
            let attributes = {label: item.label};
            if (item.id) attributes.id = item.id;
            if (item.tooltip) attributes.tooltiptext = item.tooltip;
            if (item.disabled || item.header) attributes.disabled = 'true';
            if (item.header) attributes.style = 'font-size: 80%;';
            popup.appendChild(createElement(doc, 'menuitem', attributes, item.command));
        }
    };

    /**
     * Add zotfile menu items to a main window
     * @param {Window} win Zotero main window
     */
    this.addToWindow = function(win) {
        if (!win || !win.document || windows.has(win)) return;
        var doc = win.document,
            added = {elements: [], listeners: []};
        windows.set(win, added);
        var listen = function(target, type, listener) {
            target.addEventListener(type, listener);
            added.listeners.push([target, type, listener]);
        };

        // item context menu
        var itemmenu = doc.getElementById('zotero-itemmenu');
        if (itemmenu) {
            let separator = createElement(doc, 'menuseparator', {id: 'id-zotfile-separator'});
            let attach = createElement(doc, 'menuitem', {
                id: 'id-zotfile-attach-file',
                label: zz.ZFgetString('ui.zotfile-attach-file.label'),
                tooltiptext: zz.ZFgetString('ui.zotfile-attach-file.tooltiptext')
            }, () => zz.attachFileFromSourceDirectory());
            let menu = createElement(doc, 'menu', {
                id: 'id-zotfile-manage-attachments',
                label: zz.ZFgetString('ui.zotfile-manage-attachments.label')
            });
            let popup = createElement(doc, 'menupopup', {id: 'id-zotfile-menu'});
            menu.appendChild(popup);
            for (let elem of [separator, attach, menu]) {
                itemmenu.appendChild(elem);
                added.elements.push(elem);
            }
            // show or hide zotfile menu items
            listen(itemmenu, 'popupshowing', function(event) {
                if (event.target != itemmenu) return;
                try {
                    var items = win.ZoteroPane.getSelectedItems(),
                        show = items.some(item => item.isAttachment() || item.isRegularItem());
                    for (let elem of [separator, attach, menu]) setHidden(elem, !show);
                    setDisabled(attach, items.length != 1);
                }
                catch (e) {
                    Zotero.logError(e);
                }
            });
            // build submenu
            listen(popup, 'popupshowing', function(event) {
                if (event.target != popup) return;
                try {
                    buildMenu(win, popup);
                }
                catch (e) {
                    Zotero.logError(e);
                }
            });
        }

        // tools menu
        var toolsmenu = doc.getElementById('menu_ToolsPopup');
        if (toolsmenu) {
            let options = createElement(doc, 'menuitem', {
                id: 'zotfile-options',
                label: zz.ZFgetString('ui.zotfile-options.label')
            }, () => zz.openPreferenceWindow());
            toolsmenu.appendChild(options);
            added.elements.push(options);
        }

        // tag modified tablet attachments when a tablet saved search is selected
        var collections = doc.getElementById('zotero-collections-tree');
        if (collections) listen(collections, 'click', () => {
            zz.Tablet.updateModifiedAttachmentsSearch();
        });
    };

    this.addToAllWindows = function() {
        for (let win of Zotero.getMainWindows()) {
            if (!win.ZoteroPane) continue;
            this.addToWindow(win);
        }
    };

    /**
     * Remove zotfile menu items from a main window
     * @param {Window} win Zotero main window
     */
    this.removeFromWindow = function(win) {
        var added = windows.get(win);
        if (!added) return;
        windows.delete(win);
        try {
            for (let [target, type, listener] of added.listeners) target.removeEventListener(type, listener);
            for (let elem of added.elements) elem.remove();
        }
        catch (e) {
            // window might already be closed
        }
    };

    this.removeFromAllWindows = function() {
        for (let win of Array.from(windows.keys())) this.removeFromWindow(win);
    };
};
