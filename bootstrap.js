/**
 * ZotFile bootstrap (Zotero 8 and later)
 * https://www.zotero.org/support/dev/zotero_7_for_developers
 */

var chromeHandle = null;

var ZOTFILE_SCRIPTS = ['zotfile', 'utils', 'wildcards', 'tablet', 'notifier', 'ui', 'rclone'];
var ZOTFILE_LOCALES = ['en-US', 'de-DE', 'fr-FR', 'it-IT'];

function install() {}

function uninstall() {}

async function startup({ id, version, rootURI }) {
	// register chrome://zotfile/content/ and chrome://zotfile/locale/
	var aomStartup = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
		.getService(Components.interfaces.amIAddonManagerStartup);
	var manifestURI = Services.io.newURI(rootURI + "manifest.json");
	chromeHandle = aomStartup.registerChrome(manifestURI, [
		["content", "zotfile", "chrome/content/zotfile/"]
	].concat(ZOTFILE_LOCALES.map(locale => ["locale", "zotfile", locale, "chrome/locale/" + locale + "/"])));

	// load zotfile
	for (let script of ZOTFILE_SCRIPTS) {
		Services.scriptloader.loadSubScript(rootURI + 'chrome/content/zotfile/' + script + '.js');
	}
	await Zotero.ZotFile.init({ id, version, rootURI });

	// preference pane in the Zotero settings
	await Zotero.PreferencePanes.register({
		pluginID: id,
		id: Zotero.ZotFile.prefPaneID,
		label: 'ZotFile',
		src: rootURI + 'chrome/content/zotfile/preferences.xhtml',
		scripts: [rootURI + 'chrome/content/zotfile/preferences.js']
	});

	// menu items
	Zotero.ZotFile.UI.addToAllWindows();
}

function onMainWindowLoad({ window }) {
	if (Zotero.ZotFile) Zotero.ZotFile.UI.addToWindow(window);
}

function onMainWindowUnload({ window }) {
	if (Zotero.ZotFile) Zotero.ZotFile.UI.removeFromWindow(window);
}

function shutdown(data, reason) {
	// no need to clean up when Zotero is closing
	if (reason === APP_SHUTDOWN) return;

	if (Zotero.ZotFile) {
		Zotero.ZotFile.UI.removeFromAllWindows();
		Zotero.ZotFile.shutdown();
		delete Zotero.ZotFile;
	}
	Services.strings.flushBundles();
	if (chromeHandle) {
		chromeHandle.destruct();
		chromeHandle = null;
	}
}
