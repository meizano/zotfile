/**
 * Functions for zotfile's preference pane (preferences.xhtml)
 *
 * This script is loaded by Zotero into the scope of the settings window before
 * the pane is inserted into the document.
 */

(function () {
    var zz = Zotero.ZotFile;
    var XUL_LABELED = ['checkbox', 'radio', 'button', 'menuitem'];

    var $ = function (id) {
        return document.getElementById(id);
    };

    var setDisabled = function (elem, disabled) {
        if (disabled) elem.setAttribute('disabled', 'true');
        else elem.removeAttribute('disabled');
        try {
            elem.disabled = disabled;
        }
        catch (e) {}
    };

    /**
     * Convert value from an input element to the type of the preference
     */
    var toPrefValue = function (pref, value) {
        var current = zz.getPref(pref);
        if (typeof current == 'boolean') return value === true || value === 'true';
        if (typeof current == 'number') {
            let number = parseInt(value, 10);
            return isNaN(number) ? current : number;
        }
        return String(value);
    };

    /**
     * Fill in localized strings
     */
    var localize = function (root) {
        for (let elem of root.querySelectorAll('[data-zf]')) {
            let str;
            try {
                str = zz.ZFgetString('ui.' + elem.getAttribute('data-zf'));
            }
            catch (e) {
                str = elem.getAttribute('data-zf');
            }
            if (XUL_LABELED.includes(elem.localName)) {
                elem.setAttribute('label', str);
                try {
                    elem.label = str;
                }
                catch (e) {}
            }
            else {
                elem.textContent = str;
            }
        }
    };

    /**
     * Show the preference values and save changes made by the user
     */
    var bindPreferences = function (root) {
        for (let elem of root.querySelectorAll('[data-pref]')) {
            let pref = elem.getAttribute('data-pref'),
                value = zz.getPref(pref);
            if (elem.localName == 'checkbox') {
                elem.checked = !!value;
                elem.addEventListener('command', () => {
                    zz.setPref(pref, !!elem.checked);
                    updateDisabled(root);
                    onPrefChanged(pref);
                });
            }
            else if (elem.localName == 'radiogroup' || elem.localName == 'menulist') {
                elem.value = String(value);
                elem.addEventListener('command', () => {
                    zz.setPref(pref, toPrefValue(pref, elem.value));
                    updateDisabled(root);
                    onPrefChanged(pref);
                });
            }
            else {
                elem.value = value;
                elem.addEventListener('change', () => {
                    zz.setPref(pref, toPrefValue(pref, elem.value));
                    // show the value that was actually saved
                    elem.value = zz.getPref(pref);
                    onPrefChanged(pref);
                });
            }
        }
    };

    /**
     * Enable and disable elements based on other preferences (data-enable attribute)
     */
    var updateDisabled = function (root) {
        for (let elem of root.querySelectorAll('[data-enable]')) {
            let enabled = elem.getAttribute('data-enable').split(/\s+/).filter(s => s != '').every(function (condition) {
                var negate = condition.startsWith('!'),
                    value = !!zz.getPref(negate ? condition.substr(1) : condition);
                return negate ? !value : value;
            });
            setDisabled(elem, !enabled);
        }
    };

    /**
     * Show whether the folders are valid
     */
    var updateFolderStatus = async function () {
        var show = async function (id, pref, relevant) {
            var label = $(id);
            if (!label) return;
            if (!relevant) {
                label.setAttribute('value', '');
                return;
            }
            var valid = await zz.Path.exists(zz.getPref(pref));
            label.setAttribute('value', valid ? '✓' : '✗');
            label.style.color = valid ? 'green' : 'red';
            label.style.fontWeight = 'bold';
        };
        await show('zotfile-source_dir-status', 'source_dir', true);
        await show('zotfile-dest_dir-status', 'dest_dir', !zz.getPref('import'));
        await show('zotfile-tablet.dest_dir-status', 'tablet.dest_dir', zz.getPref('tablet'));
    };

    /**
     * Alert user about errors in the renaming format
     */
    var checkRenameFormat = function (pref) {
        zz.messages_error = [];
        try {
            var item = getSelectedRegularItem();
            if (item) zz.getFilename(item, '', zz.getPref(pref), true);
        }
        catch (e) {}
        if (zz.messages_error.length > 0) {
            Services.prompt.alert(window, 'ZotFile', Array.from(new Set(zz.messages_error)).join('\n\n'));
            zz.messages_error = [];
        }
    };

    var onPrefChanged = function (pref) {
        if (['source_dir', 'dest_dir', 'import', 'tablet', 'tablet.dest_dir'].includes(pref)) updateFolderStatus();
        if (pref == 'tablet.dest_dir') changedBasefolder();
        // tablet features enabled: offer to create saved searches
        if (pref == 'tablet' && zz.getPref('tablet')) {
            if (Services.prompt.confirm(window, 'ZotFile', zz.ZFgetString('tablet.createSavedSearches', [zz.getPref('tablet.tag')])))
                zz.Tablet.createSavedSearch('both');
        }
        if (['renameFormat', 'renameFormat_patent'].includes(pref)) checkRenameFormat(pref);
        // changing to custom location: choose folder now if not defined
        if (pref == 'import' && !zz.getPref('import') && zz.getPref('dest_dir') == '') chooseFolder('dest_dir');
    };

    var chooseFolder = async function (pref) {
        var folder = await zz.chooseDirectory(window);
        if (!folder) return;
        zz.setPref(pref, folder);
        var input = $('zotfile-' + pref);
        if (input) input.value = folder;
        updateFolderStatus();
        if (pref == 'tablet.dest_dir') changedBasefolder();
    };

    // ====== //
    // TABLET //
    // ====== //

    var tabletFolder = zz.getPref('tablet.dest_dir');

    /**
     * Confirm change of the base folder if there are attachments on the tablet
     */
    var changedBasefolder = async function () {
        var folderOld = tabletFolder,
            folder = zz.getPref('tablet.dest_dir'),
            revert = false;
        if (folderOld == folder) return;
        // only ask if the old location was valid
        if (await zz.Path.exists(folderOld)) {
            let atts = await zz.Tablet.getAttachmentsOnTablet(),
                valid = await zz.Path.exists(folder);
            if (!valid)
                revert = !Services.prompt.confirm(window, 'ZotFile', zz.ZFgetString('tablet.invalidFolder', [atts.length]));
            else if (atts.length > 0)
                revert = !Services.prompt.confirm(window, 'ZotFile', zz.ZFgetString('tablet.baseFolderChanged.prompt', [atts.length]));
        }
        if (revert) {
            zz.setPref('tablet.dest_dir', folderOld);
            $('zotfile-tablet.dest_dir').value = folderOld;
            updateFolderStatus();
        }
        tabletFolder = zz.getPref('tablet.dest_dir');
    };

    var MAX_SUBFOLDERS = 15;

    var getSubfolders = function () {
        try {
            var subfolders = JSON.parse(zz.getPref('tablet.subfolders'));
            return Array.isArray(subfolders) ? subfolders : [];
        }
        catch (e) {
            return [];
        }
    };

    /**
     * Save custom subfolders and show them in the list
     */
    var setSubfolders = function (subfolders, select) {
        zz.setPref('tablet.subfolders', JSON.stringify(subfolders));
        var list = $('zotfile-tablet-subfolders');
        while (list.firstChild) list.firstChild.remove();
        for (let folder of subfolders) {
            let option = document.createElementNS('http://www.w3.org/1999/xhtml', 'option');
            option.textContent = folder.label + '  \u2014  ' + folder.path;
            list.appendChild(option);
        }
        if (select !== undefined && select >= 0 && select < subfolders.length) list.selectedIndex = select;
    };

    /**
     * Ask user for label and folder of a custom subfolder
     * @return {object} Object with label and path or null if canceled
     */
    var promptSubfolder = function (folder) {
        var sep = zz.folderSep,
            label = {value: folder ? folder.label : ''},
            path = {value: folder ? folder.path : ''};
        if (!Services.prompt.prompt(window, 'ZotFile', zz.ZFgetString('ui.label'), label, null, {value: false})) return null;
        label.value = label.value.trim();
        if (label.value == '') return null;
        var message = zz.ZFgetString('ui.subfolder') + '\n\n' + zz.ZFgetString('ui.leave-empty');
        if (!Services.prompt.prompt(window, 'ZotFile', message, path, null, {value: false})) return null;
        // when folder not defined set to label
        var value = path.value.trim() == '' ? label.value : path.value.trim();
        value = value.replace(/[\/\\:]/g, sep).replace(/&/g, 'and').replace(/[?*|"<>]/g, '');
        value = sep + value.split(sep).map(s => s.trim()).filter(s => s != '' && s != '.' && s != '..').join(sep);
        if (value == sep) return null;
        return {label: label.value, path: value};
    };

    var addSubfolder = function () {
        var subfolders = getSubfolders();
        if (subfolders.length >= MAX_SUBFOLDERS) {
            Services.prompt.alert(window, 'ZotFile', zz.ZFgetString('tablet.maxSubfolders', [MAX_SUBFOLDERS]));
            return;
        }
        var folder = promptSubfolder();
        if (!folder) return;
        subfolders.push(folder);
        setSubfolders(subfolders, subfolders.length - 1);
    };

    var editSubfolder = async function () {
        var subfolders = getSubfolders(),
            index = $('zotfile-tablet-subfolders').selectedIndex;
        if (index < 0 || index >= subfolders.length) return;
        var folderOld = subfolders[index],
            folder = promptSubfolder(folderOld);
        if (!folder) return;
        subfolders[index] = folder;
        setSubfolders(subfolders, index);
        // move attachments to the new subfolder
        if (folderOld.path.toLowerCase() == folder.path.toLowerCase()) return;
        var atts = await zz.Tablet.getAttachmentsOnTablet(folderOld.path),
            pathOld = zz.Tablet.getTabletLocationFile(folderOld.path);
        if (atts.length > 0) {
            if (!Services.prompt.confirm(window, 'ZotFile', zz.ZFgetString('tablet.moveAttsToNewSubfolder', [atts.length, folderOld.path, folder.path]))) return;
            await zz.Tablet.setTabletFolder(atts, folder.path);
        }
        zz.removeFile(pathOld);
    };

    var deleteSubfolder = async function () {
        var subfolders = getSubfolders(),
            index = $('zotfile-tablet-subfolders').selectedIndex;
        if (index < 0 || index >= subfolders.length) return;
        var subfolder = subfolders[index].path,
            path = zz.Tablet.getTabletLocationFile(subfolder);
        // attachments in subfolder
        var atts = (await zz.Path.exists(path)) ? await zz.Tablet.getAttachmentsOnTablet(subfolder) : [];
        if (atts.length > 0) {
            let flags = Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
                Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING +
                Services.prompt.BUTTON_POS_2 * Services.prompt.BUTTON_TITLE_IS_STRING;
            let choice = Services.prompt.confirmEx(window, 'ZotFile', zz.ZFgetString('tablet.attsInDeletedSub', [atts.length]), flags,
                zz.ZFgetString('tablet.attsInDeletedSub.getThem'),
                zz.ZFgetString('general.cancel'),
                zz.ZFgetString('tablet.attsInDeletedSub.moveThemToBase'), null, {value: false});
            if (choice == 1) return;
            // get attachments from tablet
            if (choice == 0) {
                for (let att of atts) {
                    try {
                        await zz.Tablet.getAttachmentFromTablet(att, false);
                    }
                    catch (e) {
                        zz.messages_fatalError.push(e);
                    }
                }
                zz.showReportMessages(zz.ZFgetString('tablet.AttsGotFromT'));
                zz.handleErrors();
            }
            // move attachments to base folder
            if (choice == 2) await zz.Tablet.setTabletFolder(atts);
        }
        if (await zz.Path.exists(path)) zz.removeFile(path);
        subfolders.splice(index, 1);
        setSubfolders(subfolders, Math.min(index, subfolders.length - 1));
    };

    var moveSubfolder = function (step) {
        var subfolders = getSubfolders(),
            index = $('zotfile-tablet-subfolders').selectedIndex,
            target = index + step;
        if (index < 0 || target < 0 || target >= subfolders.length) return;
        var folder = subfolders.splice(index, 1)[0];
        subfolders.splice(target, 0, folder);
        setSubfolders(subfolders, target);
    };

    var initTablet = function () {
        setSubfolders(getSubfolders());
        $('zotfile-tablet.dest_dir-button').addEventListener('command', () => chooseFolder('tablet.dest_dir'));
        $('zotfile-tablet-subfolders').addEventListener('dblclick', editSubfolder);
        $('zotfile-tablet-subfolders-add').addEventListener('command', addSubfolder);
        $('zotfile-tablet-subfolders-edit').addEventListener('command', editSubfolder);
        $('zotfile-tablet-subfolders-delete').addEventListener('command', deleteSubfolder);
        $('zotfile-tablet-subfolders-up').addEventListener('command', () => moveSubfolder(-1));
        $('zotfile-tablet-subfolders-down').addEventListener('command', () => moveSubfolder(1));
        $('zotfile-tablet-search').addEventListener('command', () => zz.Tablet.createSavedSearch('tablet'));
        $('zotfile-tablet-search-modified').addEventListener('command', () => zz.Tablet.createSavedSearch('tablet_modified'));
    };

    // ================== //
    // OS PATH MAPPINGS   //
    // ================== //

    var getMappings = function () {
        try {
            var mappings = JSON.parse(zz.getPref('pathMappings'));
            return Array.isArray(mappings) ? mappings : [];
        }
        catch (e) {
            return [];
        }
    };

    /**
     * Save mappings and show them in the list
     */
    var setMappings = function (mappings, select) {
        zz.setPref('pathMappings', JSON.stringify(mappings));
        var list = $('zotfile-pathMappings');
        while (list.firstChild) list.firstChild.remove();
        for (let mapping of mappings) {
            let option = document.createElementNS('http://www.w3.org/1999/xhtml', 'option');
            option.textContent = (mapping.windows || '?') + '  \u21C4  ' + (mapping.linux || '?');
            list.appendChild(option);
        }
        if (select !== undefined && select >= 0 && select < mappings.length) list.selectedIndex = select;
    };

    /**
     * Ask the user for the Windows and Linux path of the same folder
     * @return {object} Object with windows and linux paths or null if canceled
     */
    var promptMapping = function (mapping) {
        var windowsPath = {value: mapping ? mapping.windows || '' : ''},
            linuxPath = {value: mapping ? mapping.linux || '' : ''};
        if (!Services.prompt.prompt(window, 'ZotFile', zz.ZFgetString('ui.osPathMappings.windows'), windowsPath, null, {value: false})) return null;
        if (!Services.prompt.prompt(window, 'ZotFile', zz.ZFgetString('ui.osPathMappings.linux'), linuxPath, null, {value: false})) return null;
        windowsPath.value = windowsPath.value.trim().replace(/\//g, '\\');
        linuxPath.value = linuxPath.value.trim().replace(/\\/g, '/');
        if (windowsPath.value == '' && linuxPath.value == '') return null;
        return {windows: windowsPath.value, linux: linuxPath.value};
    };

    var addMapping = function () {
        var mappings = getMappings();
        var mapping = promptMapping();
        if (!mapping) return;
        mappings.push(mapping);
        setMappings(mappings, mappings.length - 1);
    };

    var editMapping = function () {
        var mappings = getMappings(),
            index = $('zotfile-pathMappings').selectedIndex;
        if (index < 0 || index >= mappings.length) return;
        var mapping = promptMapping(mappings[index]);
        if (!mapping) return;
        mappings[index] = mapping;
        setMappings(mappings, index);
    };

    var deleteMapping = function () {
        var mappings = getMappings(),
            index = $('zotfile-pathMappings').selectedIndex;
        if (index < 0 || index >= mappings.length) return;
        mappings.splice(index, 1);
        setMappings(mappings, Math.min(index, mappings.length - 1));
    };

    var initPathMappings = function () {
        setMappings(getMappings());
        $('zotfile-pathMappings').addEventListener('dblclick', editMapping);
        $('zotfile-pathMappings-add').addEventListener('command', addMapping);
        $('zotfile-pathMappings-edit').addEventListener('command', editMapping);
        $('zotfile-pathMappings-delete').addEventListener('command', deleteMapping);
    };

    /**
     * Get the regular item for the current selection in the main window
     */
    var getSelectedRegularItem = function () {
        var win = Zotero.getMainWindow();
        if (!win || !win.ZoteroPane) return null;
        var item = win.ZoteroPane.getSelectedItems()[0];
        if (!item) return null;
        if (!item.isRegularItem() && item.parentItemID) item = Zotero.Items.get(item.parentItemID);
        return item && item.isRegularItem() ? item : null;
    };

    var previewFilename = function () {
        var preview;
        zz.messages_error = [];
        try {
            var item = getSelectedRegularItem();
            if (!item) throw new Error('No item selected');
            // user input is not part of the preview
            preview = zz.getFilename(item, 'filename.pdf', zz.getPref('renameFormat'), true);
        }
        catch (e) {
            preview = zz.ZFgetString('renaming.preview');
        }
        zz.messages_error = [];
        $('zotfile-preview').value = preview;
    };

    var init = function (root) {
        if (root._zotfileInitialized) return;
        root._zotfileInitialized = true;
        localize(root);
        bindPreferences(root);
        updateDisabled(root);
        updateFolderStatus();
        previewFilename();
        $('zotfile-source_dir-button').addEventListener('command', () => chooseFolder('source_dir'));
        $('zotfile-dest_dir-button').addEventListener('command', () => chooseFolder('dest_dir'));
        $('zotfile-preview-button').addEventListener('command', previewFilename);
        initTablet();
        initPathMappings();
        $('zotfile-website-link').addEventListener('click', () => zz.Utils.loadURI('http://www.zotfile.com/index.html#renaming-rules'));
    };

    // Zotero dispatches a 'load' event on the pane once it is inserted into the document.
    // Additionally, check for the pane periodically in case the event is missed.
    document.addEventListener('load', function (event) {
        if (event.target && event.target.id == 'zotfile-prefs') init(event.target);
    }, true);
    var tries = 0;
    var waitForPane = function () {
        var root = $('zotfile-prefs');
        if (root) init(root);
        else if (++tries < 400) setTimeout(waitForPane, 50);
    };
    waitForPane();
})();
