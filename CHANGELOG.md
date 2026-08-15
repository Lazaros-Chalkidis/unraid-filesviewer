
# Files Viewer

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
