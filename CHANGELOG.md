
# Files Viewer

## Version 2026.11.07

### Added
- Compress. Tick files or folders and pack them into a zip or tar.gz next to them, with a name you choose, progress and cancel. The plugin writes both formats itself, streamed, so nothing waits on a tool that gives no feedback. Zip takes files over 4 GB, links are left out, and a cancelled run leaves nothing behind
- Extract. Open a zip or tar archive, switch editing on, and the button above the listing unpacks it into a new folder named after it, next to it, with progress and cancel. Entries are read one at a time by the plugin itself, anything that would land outside that folder is refused, links are left out, and the files take the owner and permissions of the folder rather than what the archive says. 7z and rar stay listing only, they need tools that stock Unraid does not ship
- The tool can open with editing already on, from Open in under Browsing in the settings. It still starts in preview only unless you change that
- A Palette setting under Appearance. The plugin follows the theme chosen in Display Settings, and a custom theme changes the page without touching that, so it came out light on a dark theme. Lock it to dark or light and it matches what you actually see
- The plugin can be translated. Every string on both pages and in the browser goes through Unraid's own translation layer, and Greek, German and French are in the repo under languages/. Unraid reads plugin translations from its language packs, so they reach users once those packs carry them
- The table sorts by any column. Click a header to sort by it, click again to flip the direction. The choice is kept in that browser, and the Sorting settings stay the default for the rest
- Shift-click ticks a range, in the table and in the folder list. With nothing open, Ctrl+A ticks the whole folder, Delete asks to delete what is ticked and F2 renames the one ticked item
- Download takes more than one item. Tick several files, or a folder, and they come down as one zip streamed straight to the browser, nothing is written on the server first
- A copy, move, extract, compress or checksum that runs longer than a minute ends with an Unraid notification, so you can leave the page and still learn how it went. It can be switched off under Notifications in the settings
- Copy path, in the preview bar, puts the path of the open file, or of the folder you are in, on the clipboard
- Search. The new button in the bar looks through every folder below the one you are in, by part of a name or a pattern like *.mkv, with a running count and Cancel. Results open with a click, and they stay around when you come back from one
- Which disk. The button in the preview bar names the disk or pool behind the open file or folder, with the drive's identification, device, size, filesystem and temperature as Unraid's Main page shows them. Under /mnt/user it looks for the same path on every disk and pool first, with a click to open the copy it finds; it asks before looking, because a disk that is asleep may wake up, and a file found on more than one disk is called out, since /mnt/user shows only one of them
- Unraid defaults. One button in the Owner and the Permission dialogs sets nobody:users, folders 777 and files 666 on the ticked items and everything inside them, what New Permissions in Tools does for a whole share, here for what you picked
- Checksum. With a file open, the button in the preview bar computes its SHA256, SHA1, MD5 or SHA512 in the background with a progress bar and Cancel, copies it with a click, and compares it against one you paste
- Full screen for images. The button above an open image shows it on the whole screen, and the arrows, the keys or a tap at the sides walk through the other images of the folder in the order you see them. Closing it leaves the last image open in the preview
- The editor has line numbers, a status line with the cursor position, and find and replace. Ctrl+F opens it, Enter and Shift+Enter step through the matches, Match case is a tick box, Replace and Replace all do what they say. Ctrl+S saves and Tab inserts a tab instead of leaving the editor

### Changed
- The dialogs are bigger. Their text was a notch smaller than the folder table, now it is the same size, the fields and buttons grew with it, and the panels are wider
- Space and Search act on the ticked folder when exactly one is ticked, and on the folder you are in otherwise. Before, Space always scanned the folder you were in, whatever was ticked
- Escape closes the Space and Search panes, the way it closes a preview
- In the table view the tick box sits before the name, where the eye lands first, instead of after it
- The sidebar and the table agree on what is ticked. Ticking in one updates the other, and the header tick box in the table follows along

### Fixed
- Extracting an archive that held a single file put that file in a folder named after the file, so zipping a text file and unzipping it again left a folder with the file's name and, after moving the file out, a (1) on it. A single file or folder now comes out as itself, next to the archive, and a name that is taken gets a number instead of a refusal
- Compress stayed on with only archives ticked and offered to pack a zip into another zip. It is off now, and the tooltip says why
- The folder list in the Copy and Move dialog, and the sheet tabs of a spreadsheet, picked up Unraid's own button styling: orange borders, capitals and wide letter spacing. They follow the plugin's look now, in both themes
- The text fields in the dialogs took Unraid's underline style while the drop-downs next to them were boxes. They are all boxes now, and the drop-downs have their arrow back
- The editor's line numbers took the whole width on Unraid and squeezed the text to a sliver at the right, a side effect of Unraid's own rule for pre blocks. The glyph block of the font preview was framed and set in Unraid's font for the same reason
- Typing in the folder filter while the Space, Search or Upload pane was open replaced the pane with the folder table, and so did the sidebar toggle
- Clicking a second file while a slow one was still loading could leave the first file's content in the preview under the second file's name. A late answer is dropped now
- Leaving the page with unsaved changes in the editor, or with an upload running, asks first
- A few texts in the progress dialogs were not translated
- Ticking a file left Open raw and Checksum greyed out, they only looked at the file open in the preview. Both take the ticked file now, and Copy path and Which disk follow a single ticked item too. Wrap still needs an open text preview, and its tooltip says so when it is off
- Escape in a dialog closed the dialog and, with the same keystroke, the preview behind it
- When the window is too narrow for the button labels, or a translation runs long, the action bar keeps the icons and drops the labels, and wraps only on a phone, instead of cutting off Delete and Recycle Bin at the right edge. Thanks to Sebastian Oehm for the fix (pull request #9)
- The contents of a zip never listed on Unraid, every zip came up as empty. The plugin read the output of unzip and expected the date the way Debian prints it, Slackware prints it the other way round, so every line was dropped. Zip archives are read through PHP's own zip support now, nothing to parse
- An owner or permission change showed up in the folder list on the left but not in the table, which kept the old values until you left the folder and came back

## Version 2026.10.28

### Fixed
- With hidden files switched on, the recycle bin folder itself showed up in the listing like any other folder, and could be opened, renamed or deleted from there. It is kept out of the browser now and only reachable through the Recycle Bin button
- Deleting something that sits directly under a disk or pool, outside any share, asked to move it to the recycle bin and then refused. The bin lives inside each share, so there is none at that level. The confirmation now says it will be a permanent delete, and goes through

## Version 2026.08.24

### Added
- A short guide covering the parts that are not obvious the first time, in GUIDE.md

### Fixed
- A greyed out button now says what it is waiting for when you hover it, instead of repeating its own name. Most of them need editing switched on and a file ticked, which was not obvious
- The plugin could be missing from Tools entirely. It was listed under System Information, a section that only exists if you happen to have another plugin that creates it. It has its own Viewers Suite section now, which is always there

## Version 2026.08.15

### Added
- One pane by default. The folder is listed across the whole window with type, size, date, owner, group and mode, and a header that stays put while you scroll. The icon at the top right slides the folder list back out when you want it, and remembers which one you left it on
- Turning on editing adds a tick column to that listing, so files can be picked for the toolbar actions from either pane
- Opening a folder that sits on a sleeping disk says so on the row while it waits, instead of looking like the click did nothing
- Folders in that listing have a Measure button in the size column. It works out what the folder actually holds, the same job the Space button runs, and only for the row you asked about

### Fixed
- Closing a video or audio preview before it finished left an error in the syslog and kept the disk reading a file nobody was watching. It now stops as soon as the player goes away

## Version 2026.08.12

### Fixed
- A recycle bin that came back with a restored backup, into a share it did not belong to, offered a Restore that could never work. The bin now says which share the items came from and leaves that button out
- A Space scan was lost if you left the page and came back. The scan itself kept running on the server, it was only the page that forgot about it. It picks it back up now, and shows the result if it finished while you were away
- An empty folder left you stuck. The row that walks back up was dropped along with the rest of the listing, so the breadcrumb was the only way out
- The -wal and -shm files sitting next to a SQLite database now say what they are and point at the database, instead of just refusing to open

## Version 2026.08.06

### New Features
- Favourites. Pin a folder or a file with the star next to the path, and jump straight back to it from the Favourites button. They are kept on the server, so they are there from any browser
- Action buttons can be plain grey instead of coloured, from the settings page. Delete and Recycle Bin keep their colour either way

### Fixed
- The recycle bin never emptied itself. The daily clean-up was never installed, so nothing ever aged out. It runs now and follows the retention you set
- Deleting a share or a disk from the top level emptied everything inside it. Those can no longer be deleted, renamed or moved
- A delete could still go through permanently while the recycle bin was switched on. The setting decides now, not the page
- Owner and permission changes did not show in the listing until you left the folder and came back
- Updating the plugin reset the permissions format back to octal every time
- Create and Upload went dead whenever a file was open in the preview
- There was no obvious way to close a preview. Clicking the open file again closes it, and so does Escape
- The Edit button gave no hint why it was greyed out on a file that previews fine. The editor takes files up to 2 MB, whatever the preview limit is set to
- An upload that was cancelled or cut off left a hidden file behind in the folder
- A folder with more items than the listing can hold gave no sign that anything was missing
- The Space scan looked frozen. The progress counter and the Cancel button only woke up every so many folders, so on a share with a lot of files in few folders they barely moved. They follow the files now
- A file too big to preview said only that it was over the limit. It names the limit and the kind of file now, so you can see which one you hit
- All four Unraid themes are properly supported now. Gray and Azure were falling back to the Black and White palettes, and the colours on the buttons and file icons were too faint to read on the light ones
- Applying settings wrote to the flash drive even when nothing had changed, and said nothing when a write failed

### Changed
- The recycle bin is off by default now. Existing installs keep whatever you had set
- Text preview limit, inline image limit and archive listing limit always showed the first option in the list instead of what you had saved, and pressing Apply then wrote that first option over your setting
- Removing the plugin no longer deletes anything of yours. Your settings and your recycle bins stay where they are, and a reinstall picks them up
- The Space button is off by default now. It reads every file under the folder and runs for many minutes on a large share, so you switch it on yourself when you want it
- The line under each name shows when the file was last changed, and drops the words Folder, File and Text that the icon already tells you
- Leaving a file with unsaved changes asks in the plugin's own window instead of the browser popup

## Version 2026.07.25

### Fixed
- Plugin URL now matches the Community Applications template exactly

## Version 2026.07.21

### Fixed
- Support links now point to GitHub Issues, and the README wording was tightened

## Version 2026.07.10

### First release
- Tools Page: A full-page two-pane browser under Tools > Files Viewer, folders on the left and preview on the right
- Rooted at /mnt: Every disk, pool, and share reachable in one place, and nothing above /mnt ever is
- File Previews: Images, text and code with syntax highlighting, Markdown, audio, video, and PDF shown in place
- Rich Formats: Word documents, spreadsheets, CSV as a table, fonts, and e-books open in the browser too
- Archive Contents: Zip and tar archives (including tar.gz, tar.bz2, tar.xz) listed without extracting anything
- Database Browser: SQLite databases open read-only on the server, pick a table and page through the rows 100 at a time
- Write Operations: Create files and folders, rename, move, copy, delete, and change owner or permissions from the top bar
- In-Place Editor: Text and config files up to 2 MB open in the preview pane and save straight back
- Upload and Download: Send files to the current folder with mid-transfer cancel, and pull any file back out
- Background Jobs: Long copies, moves, and deletes run in a worker with live progress and a cancel button
- Recycle Bin: Deletes made in Files Viewer move to a per-share bin, with restore, purge, and daily auto-empty (30 or 60 days, or never)
- Bin Off the Network: Samba vetoes the bin folder on every share and it stays root-only on disk, which covers NFS as well
- Space Analysis: Ranks everything inside a folder by the space it actually takes, with progress while it counts and drill-in
- Audit Log: Every write lands in /var/log/filesviewer.log with the time, the action, and the paths involved
- Disk Friendly: Browsing reads directory entries and metadata only and never wakes a sleeping disk, opening a file wakes just the disk that holds it
- Quick Navigation: Breadcrumb path, type-to-filter, arrow keys and Enter, and it remembers the folder you were last in
- Header Button: Stacked-pages icon in the WebGUI top bar jumps straight to the tool
- Theme-Aware: Inherits the active Unraid theme (black, white, azure, gray) without override hacks
- Settings Page: Standalone settings at Settings > Files Viewer with browser-native form submission
