# ZotFile: Advanced PDF management for Zotero
### Joscha Legewie

Zotfile is a Zotero plugin to manage your attachments: automatically rename, move, and attach PDFs (or other files) to Zotero items, sync PDFs from your Zotero library to your (mobile) PDF reader (e.g. an iPad, Android tablet, etc.) and extract annotations from PDF files.

Detailed information are available from the [zotfile website](http://www.zotfile.com).

## Zotero 8, 9 and 10

Version 6.0.0 of this fork is a port to the bootstrapped plugin format required by recent Zotero versions (tested with Zotero 10.0.8). It includes attaching new files from a source folder, renaming and moving attachments (stored or linked, with wildcard-based subfolders), automatic renaming of new attachments, sending files to and getting them back from a tablet folder (background and foreground mode, custom or collection-based subfolders, saved searches for tablet files), and the settings pane (Settings -> ZotFile).

Information about files on the tablet is now stored in `zotfile-tablet.json` in the Zotero data directory instead of the attachment note. Data saved in notes by older versions is still read and moved to the new file the next time the attachment changes.

Not included in this version: extraction of PDF annotations and of the table of contents (also when getting files back from the tablet). Zotero's built-in PDF reader covers annotations and outlines.

### OS path mappings

If a folder is available under a different path on each operating system (for example a Google Drive folder that is `G:\My Drive\...` on Windows and mounted with rclone under `/media/.../GDrive/...` on Linux), add a mapping under Settings -> ZotFile -> Other Advanced Settings -> OS Path Mappings. Paths are translated automatically depending on the operating system, so the same source folder, custom location and tablet folder settings work on both systems.

Build with `python build.py`, then install `zotfile-6.0.0.xpi` in Zotero via "Tools -> Plugins -> gear icon -> Install Plugin From File". If you use ZotFile's automatic renaming, turn off Zotero's own "Automatically rename locally added files" setting to avoid both renaming the same file.

## Development status

Zotfile is currently not actively developed and maintained! Updates are extremely rare and I will mostly not respond to issues and pull requests here on github.

## Installation

Version 6.0.0 requires **Zotero 8 or later** (tested with Zotero 10.0.8). Build the extension with `python build.py` (or `make`), then install the resulting `zotfile-6.0.0.xpi` in Zotero via "Tools -> Plugins -> gear icon -> Install Plugin From File".

To install the **development version** from github:

1. download `.zip` file from github and extract it
2. run `python build.py` to create the `.xpi` file (requires `manifest.json`, `bootstrap.js`, `prefs.js` and the `chrome` directory at the top level)
3. In Zotero go to 'Tools -> Plugins -> gear icon -> Install Plugin From File' and pick the `.xpi` file.

## License
The source code is released under GNU General Public License, version 3.0

Contributions preferably through pull requests are welcome!

## Changelog

The full changelog is available [here](http://zotfile.com/#changelog).
