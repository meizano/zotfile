
/**
 * Callback implementing the notify() method to pass to the Notifier
 */
Zotero.ZotFile.notifierCallback = new function() {

    var zz = Zotero.ZotFile;

    /**
     * Callback function for the event listener
     * https://www.zotero.org/support/dev/client_coding/javascript_api#notification_system
     * @param  {string} event     Event: add, modify, delete, ...
     * @param  {string} type      Object type (zotfile only observes 'item')
     * @param  {array}  ids       Array with object ids.
     * @param  {object} extraData Extra data (e.g. deleted items)
     * @return {void}
     */
    this.notify = async function (event, type, ids, extraData) {
        try {
            // automatic renaming
            if (type != 'item' || event != 'add' || zz.getPref('automatic_renaming') == 1) return;
            // retrieve the added items
            var atts = Zotero.Items.get(ids)
                .filter(att => att.isImportedAttachment() && !att.isTopLevelItem())
                .filter(zz.checkFileType);
            atts = await zz.Utils.asyncFilter(atts, att => att.fileExists());
            // rename attachments
            if (atts.length > 0) setTimeout(() => rename(atts), 100);
        }
        catch (e) {
            Zotero.logError(e);
        }
    };

    /**
     * Automatic renaming of Items
     * @param  {array} attachments Array with attachment items
     * @return {void}
     */
    var rename = function (attachments) {
        var auto_rename = zz.getPref('automatic_renaming');
        // iterate through attachments
        for (let att of attachments) {
            try {
                let item = Zotero.Items.get(att.parentItemID);
                if (!item || !item.isRegularItem()) continue;
                // check whether key is excluded
                if(zz.excludeAutorenameKeys.includes(att.key) || zz.excludeAutorenameKeys.includes(item.key)) {
                    zz.Utils.removeFromArray(zz.excludeAutorenameKeys, item.key);
                    continue;
                }
                // skip if file already has correct filename
                let filename = att.attachmentFilename.replace(/\.[^/.]+$/, '');
                if(filename.indexOf(zz.getFilename(item, filename, undefined, true)) === 0) continue;
                // exclude current key for next event
                zz.excludeAutorenameKeys.push(att.key);
                // always ask user
                if(auto_rename == 2) ask(att);
                // ask user if item has other attachments
                if(auto_rename == 3) {
                    let item_atts = Zotero.Items.get(item.getAttachments())
                        .filter(zz.checkFileType)
                        .filter(att => att.isImportedAttachment() || att.attachmentLinkMode == Zotero.Attachments.LINK_MODE_LINKED_FILE);
                    if (item_atts.length == 1) on_confirm(att);
                    if (item_atts.length > 1) ask(att);
                }
                // always rename
                if(auto_rename == 4) on_confirm(att);
            }
            catch (e) {
                Zotero.logError(e);
            }
        }
    };

    /**
     * Ask user whether the attachment should be renamed (clickable notification)
     */
    var ask = function (att) {
        var message = {
            lines: [att.attachmentFilename],
            txt: zz.ZFgetString('renaming.clickMoveRename'),
            icons: [zz.getIcon(att)]
        };
        var duration = zz.getPref('info_window_duration_clickable'),
            clicked = false;
        var pw = zz.infoWindow(zz.ZFgetString('general.newAttachment'), message, duration, () => {
            clicked = true;
            on_confirm(att);
        });
        // fall back to a dialog if clicks on the notification can not be observed
        if (!pw.clickable && !clicked) {
            pw.close();
            if (zz.confirm(zz.ZFgetString('renaming.renameNew.confirm', [att.attachmentFilename])))
                on_confirm(att);
        }
    };

    var on_confirm = async function (att) {
        try {
            // rename attachment
            att = await zz.renameAttachment(att);
            zz.messages_report = [];
            // user notification
            var progress_win = zz.progressWindow(zz.ZFgetString('general.newAttachmentRenamed'));
            var progress = new progress_win.ItemProgress(zz.getIcon(att), att.getField('title'));
            progress.setProgress(100);
            progress_win.startCloseTimer(zz.getPref('info_window_duration'));
        }
        catch (e) {
            if (e && e.name == 'UserAbortion') return;
            zz.messages_fatalError.push(e);
            zz.handleErrors(zz.ZFgetString('renaming.renamingFailed'));
        }
    };
};
