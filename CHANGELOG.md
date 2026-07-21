# Files Viewer

## 2026.07.21

Changed: support links now point to GitHub Issues, and the README wording was tightened

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
