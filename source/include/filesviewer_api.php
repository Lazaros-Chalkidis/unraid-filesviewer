<?php
/* ============================================================================
   FILES VIEWER
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

declare(strict_types=1);

final class FilesViewerEndpoint
{
    private const PLUGIN_NAME = 'filesviewer';
    private const CFG_FILE    = '/boot/config/plugins/filesviewer/filesviewer.cfg';
    private const VAR_INI     = '/var/local/emhttp/var.ini';

    // hard ceiling so a directory with tens of thousands of entries cannot stall
    // the request or freeze the browser. anything past this is reported truncated.
    private const LIST_MAX = 5000;

    private static array $iniCache = [];

    // one parse per file per request, the same ini gets read from several call paths
    private static function cachedIniRead(string $path, bool $sections = false): array
    {
        $key = $path . ($sections ? '|s' : '|f');
        if (array_key_exists($key, self::$iniCache)) return self::$iniCache[$key];
        if (!is_file($path)) return self::$iniCache[$key] = [];
        $data = @parse_ini_file($path, $sections);
        return self::$iniCache[$key] = (is_array($data) ? $data : []);
    }

    // gate for every request. token comes from unraid's var.ini
    public static function validateCsrf(): bool
    {
        $expected = '';
        $var = @parse_ini_file(self::VAR_INI);
        if (is_array($var) && !empty($var['csrf_token'])) {
            $expected = (string)$var['csrf_token'];
        } elseif (isset($GLOBALS['var']) && is_array($GLOBALS['var']) && !empty($GLOBALS['var']['csrf_token'])) {
            $expected = (string)$GLOBALS['var']['csrf_token'];
        }

        // no token server-side: fresh install or a setup that delivers it elsewhere.
        // emhttpd auth still gates the session, so let it through
        if ($expected === '') return true;

        $sent = '';
        if (array_key_exists('csrf_token', $_POST)) {
            $sent = (string)$_POST['csrf_token'];
        } elseif (array_key_exists('csrf_token', $_GET)) {
            $sent = (string)$_GET['csrf_token'];
        } elseif (isset($_SERVER['HTTP_X_CSRF_TOKEN'])) {
            $sent = (string)$_SERVER['HTTP_X_CSRF_TOKEN'];
        }

        if ($sent === '') return false;
        return hash_equals($expected, $sent);  // constant time, no early-exit leak
    }

    public static function generateNonce(): string
    {
        return bin2hex(random_bytes(8));
    }

    // user-facing config, defaults applied
    public static function config(): array
    {
        $cfg = self::cachedIniRead(self::CFG_FILE);

        $sort = strtolower((string)($cfg['FV_SORT'] ?? 'name'));
        if (!in_array($sort, ['name', 'size', 'modified'], true)) $sort = 'name';

        $dir = strtolower((string)($cfg['FV_SORT_DIR'] ?? 'asc'));
        if (!in_array($dir, ['asc', 'desc'], true)) $dir = 'asc';

        return [
            'roots'         => self::allowedRoots(),
            'show_hidden'   => (($cfg['FV_SHOW_HIDDEN']   ?? '0') === '1'),
            'folders_first' => (($cfg['FV_FOLDERS_FIRST'] ?? '1') === '1'),
            'sort'          => $sort,
            'sort_dir'      => $dir,
            'text_cap_kb'   => max(64, min(20480, (int)($cfg['FV_TEXT_CAP_KB'] ?? 2048))),
            'md_render'     => (($cfg['FV_MD_RENDER'] ?? '1') === '1'),
            'img_max_mb'    => max(1, min(500, (int)($cfg['FV_IMG_MAX_MB'] ?? 50))),
            'archive_max'   => max(50, min(20000, (int)($cfg['FV_ARCHIVE_MAX'] ?? 1000))),
            'autoplay'      => (($cfg['FV_AUTOPLAY'] ?? '0') === '1'),
            'remember'      => (($cfg['FV_REMEMBER'] ?? '1') === '1'),
            'recycle'       => (($cfg['FV_RECYCLE'] ?? '1') === '1'),
            'recycle_days'  => in_array((string)($cfg['FV_RECYCLE_DAYS'] ?? '30'), ['30', '60', 'never'], true) ? (string)($cfg['FV_RECYCLE_DAYS'] ?? '30') : '30',
            'perms_format'  => in_array(strtolower((string)($cfg['FV_PERMS_FORMAT'] ?? 'octal')), ['octal', 'symbolic'], true) ? strtolower((string)($cfg['FV_PERMS_FORMAT'] ?? 'octal')) : 'octal',
        ];
    }

    // the viewer is rooted at /mnt. every path the endpoint touches must resolve
    // under here, so browsing can never escape above the array and pool mounts
    public static function allowedRoots(): array
    {
        $real = realpath('/mnt');
        return ($real !== false && is_dir($real)) ? [$real] : [];
    }

    // the single most important check in the plugin. resolve the request to a real
    // path, then confirm it sits under an allowed root. this defeats ../ traversal
    // and symlinks that point outside the roots, since realpath collapses both.
    // mustBe: 'dir', 'file', or '' for either.
    public static function safePath(string $req, string $mustBe = ''): ?string
    {
        if ($req === '' || strpos($req, "\0") !== false) return null;  // reject null-byte tricks

        $real = realpath($req);
        if ($real === false) return null;

        $inside = false;
        foreach (self::allowedRoots() as $root) {
            // trailing separator on the prefix so /mnt/user cannot match /mnt/userdata
            if ($real === $root || strpos($real, $root . DIRECTORY_SEPARATOR) === 0) {
                $inside = true;
                break;
            }
        }
        if (!$inside) return null;

        if ($mustBe === 'dir'  && !is_dir($real))  return null;
        if ($mustBe === 'file' && !is_file($real)) return null;

        return $real;
    }

    // which root contains a resolved path, used to clamp the breadcrumb to the root
    private static function rootOf(string $real): ?string
    {
        foreach (self::allowedRoots() as $root) {
            if ($real === $root || strpos($real, $root . DIRECTORY_SEPARATOR) === 0) return $root;
        }
        return null;
    }

    // extension to preview category. drives the list icon now, the preview type later.
    public static function category(string $ext): string
    {
        static $map = [
            'img'   => ['jpg','jpeg','png','gif','webp','bmp','ico','svg','avif'],
            'code'  => ['txt','log','conf','cfg','ini','sh','bash','php','js','ts','json','xml',
                        'yml','yaml','csv','tsv','html','css','py','rb','go','rs','c','h','cpp','sql','env','plg',
                        'srt','vtt','ass','ssa','sub','toml','properties','editorconfig','gitignore',
                        'gitattributes','dockerignore','dockerfile','npmrc','ndjson','jsonl','geojson',
                        'tf','tfvars','hcl','reg','ps1','psm1','bat','cmd','zsh','fish','lua','pl','pm',
                        'r','kt','kts','swift','scala','clj','cljs','ex','exs','erl','dart','awk','groovy',
                        'gradle','cmake','mk','htm','xhtml','rss','atom','scss','sass','less','styl','jsx',
                        'tsx','vue','svelte','map','m3u','m3u8','pls','cue','nfo','diff','patch','list',
                        'crt','cer','csr','pub'],
            'md'    => ['md','markdown'],
            'pdf'   => ['pdf'],
            'audio' => ['mp3','wav','ogg','oga','m4a','flac','aac','opus'],
            'video' => ['mp4','webm','ogv','mkv','mov','avi','m4v'],
            'arch'  => ['zip','tar','gz','tgz','bz2','xz','7z','rar'],
            'sqlite'=> ['db','db3','sqlite','sqlite3'],
            'doc'   => ['docx','docm'],
            'sheet' => ['xlsx','xlsm','xls','ods'],
            'ebook' => ['epub'],
            'font'  => ['ttf','otf','woff','woff2'],
        ];
        $ext = strtolower($ext);
        foreach ($map as $cat => $exts) {
            if (in_array($ext, $exts, true)) return $cat;
        }
        return 'bin';
    }

    // a real type can hide behind a trailing suffix like a backup copy. scan the
    // dot segments after the basename from the end and return the first that maps
    // to a previewable type, so objects.json.071.bak still reads as json. the
    // basename is never an extension candidate, so json.backup.dat stays binary.
    // a run with nothing previewable keeps its last segment just for display.
    public static function effectiveExt(string $name): string
    {
        $parts = explode('.', $name);
        if (count($parts) < 2) return '';
        $cands = array_slice($parts, 1);
        for ($i = count($cands) - 1; $i >= 0; $i--) {
            $e = strtolower($cands[$i]);
            if ($e !== '' && self::category($e) !== 'bin') return $e;
        }
        return strtolower($cands[count($cands) - 1]);
    }

    // fixed extension to mime map. the streaming endpoint (next phase) sets
    // Content-Type from this and never from the file content, so a file cannot
    // dictate its own type. unknown extensions fall back to octet-stream.
    public static function mimeFor(string $ext): string
    {
        static $map = [
            'jpg'=>'image/jpeg','jpeg'=>'image/jpeg','png'=>'image/png','gif'=>'image/gif',
            'webp'=>'image/webp','bmp'=>'image/bmp','ico'=>'image/x-icon','svg'=>'image/svg+xml','avif'=>'image/avif',
            'pdf'=>'application/pdf',
            'mp3'=>'audio/mpeg','wav'=>'audio/wav','ogg'=>'audio/ogg','oga'=>'audio/ogg',
            'm4a'=>'audio/mp4','flac'=>'audio/flac','aac'=>'audio/aac','opus'=>'audio/ogg',
            'mp4'=>'video/mp4','webm'=>'video/webm','ogv'=>'video/ogg','mkv'=>'video/x-matroska',
            'mov'=>'video/quicktime','m4v'=>'video/mp4',
            'txt'=>'text/plain','log'=>'text/plain','md'=>'text/plain',
            'ttf'=>'font/ttf','otf'=>'font/otf','woff'=>'font/woff','woff2'=>'font/woff2',
            'docx'=>'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'xlsx'=>'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'epub'=>'application/epub+zip',
        ];
        $ext = strtolower($ext);
        if (isset($map[$ext])) return $map[$ext];
        // text and code types view inline as plain text, so the browser shows
        // them in a tab instead of downloading, and never renders or runs them
        if (in_array(self::category($ext), ['code', 'md'], true)) return 'text/plain';
        return 'application/octet-stream';
    }

    // ---- directory listing ---------------------------------------------------

    public static function listDir(string $req): array
    {
        $cfg   = self::config();
        $roots = $cfg['roots'];

        // empty path: one root opens straight into it, several show a picker
        if ($req === '') {
            if (count($roots) === 1) {
                $req = $roots[0];
            } else {
                return self::rootPickerPayload($roots);
            }
        }

        $real = self::safePath($req, 'dir');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];

        $names = @scandir($real);
        if ($names === false) return ['ok' => false, 'error' => 'cannot read directory'];

        $root       = self::rootOf($real) ?? $real;
        $showHidden = $cfg['show_hidden'];
        $entries    = [];
        $seen       = 0;

        foreach ($names as $name) {
            if ($name === '.' || $name === '..') continue;
            if (!$showHidden && $name[0] === '.') continue;
            if (++$seen > self::LIST_MAX) break;

            $full  = $real . DIRECTORY_SEPARATOR . $name;
            $isDir = is_dir($full);
            $ext   = $isDir ? '' : self::effectiveExt($name);
            $st    = @stat($full);

            $entries[] = [
                'name'     => $name,
                'path'     => $full,
                'is_dir'   => $isDir,
                'ext'      => $ext,
                'category' => $isDir ? 'dir' : self::category($ext),
                'size'     => ($isDir || $st === false) ? 0 : (int)$st['size'],
                'mtime'    => $st !== false ? (int)$st['mtime'] : 0,
                'owner'    => $st !== false ? self::uidName((int)$st['uid']) : '',
                'perms'    => $st !== false ? self::permStringFull((int)$st['mode']) : '',
                'mode'     => $st !== false ? self::octalPerms((int)$st['mode']) : '',
            ];
        }

        self::sortEntries($entries, $cfg['sort'], $cfg['sort_dir'], $cfg['folders_first']);

        return [
            'ok'         => true,
            'path'       => $real,
            'is_root'    => ($real === $root),
            'parent'     => ($real === $root) ? '' : dirname($real),
            'breadcrumb' => self::breadcrumb($real, $root),
            'roots'      => $roots,
            'count'      => count($entries),
            'truncated'  => ($seen > self::LIST_MAX),
            'entries'    => $entries,
        ];
    }

    // when more than one root is configured, the top level lists the roots
    private static function rootPickerPayload(array $roots): array
    {
        $entries = [];
        foreach ($roots as $r) {
            $st = @stat($r);
            $entries[] = [
                'name'     => $r,
                'path'     => $r,
                'is_dir'   => true,
                'ext'      => '',
                'category' => 'dir',
                'size'     => 0,
                'mtime'    => $st !== false ? (int)$st['mtime'] : 0,
                'owner'    => $st !== false ? self::uidName((int)$st['uid']) : '',
                'perms'    => $st !== false ? self::permStringFull((int)$st['mode']) : '',
                'mode'     => $st !== false ? self::octalPerms((int)$st['mode']) : '',
            ];
        }
        return [
            'ok'          => true,
            'path'        => '',
            'is_root'     => true,
            'parent'      => '',
            'breadcrumb'  => [],
            'roots'       => $roots,
            'count'       => count($entries),
            'truncated'   => false,
            'entries'     => $entries,
            'root_picker' => true,
        ];
    }

    // segments from the root down to the current directory, each a navigable path
    private static function breadcrumb(string $real, string $root): array
    {
        $crumbs = [['name' => basename($root) ?: $root, 'path' => $root]];
        if ($real === $root) return $crumbs;

        $rest = trim(substr($real, strlen($root)), DIRECTORY_SEPARATOR);
        if ($rest === '') return $crumbs;

        $acc = $root;
        foreach (explode(DIRECTORY_SEPARATOR, $rest) as $seg) {
            $acc .= DIRECTORY_SEPARATOR . $seg;
            $crumbs[] = ['name' => $seg, 'path' => $acc];
        }
        return $crumbs;
    }

    private static function sortEntries(array &$entries, string $sort, string $dir, bool $foldersFirst): void
    {
        $mul = ($dir === 'desc') ? -1 : 1;
        usort($entries, static function ($a, $b) use ($sort, $mul, $foldersFirst) {
            // folders stay above files regardless of the chosen direction
            if ($foldersFirst && $a['is_dir'] !== $b['is_dir']) return $a['is_dir'] ? -1 : 1;

            switch ($sort) {
                case 'size':     $c = $a['size']  <=> $b['size'];  break;
                case 'modified': $c = $a['mtime'] <=> $b['mtime']; break;
                default:         $c = strcasecmp($a['name'], $b['name']); break;
            }
            if ($c === 0) $c = strcasecmp($a['name'], $b['name']);  // stable tie-break by name
            return $c * $mul;
        });
    }

    // ---- single-file metadata (the fallback card) ----------------------------

    public static function meta(string $req): array
    {
        $real = self::safePath($req, 'file');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];

        $ext  = self::effectiveExt(basename($real));
        $perm = @fileperms($real);

        return [
            'ok'       => true,
            'name'     => basename($real),
            'path'     => $real,
            'ext'      => $ext,
            'category' => self::category($ext),
            'mime'     => self::mimeFor($ext),
            'size'     => (int)@filesize($real),
            'mtime'    => (int)@filemtime($real),
            'perms'    => $perm !== false ? self::permStringFull($perm) : '',
            'mode'     => $perm !== false ? self::octalPerms($perm) : '',
        ];
    }

    // rwx string from the stat mode, like the ls long format
    private static function permString(int $mode): string
    {
        $bits = [0x0100,0x0080,0x0040, 0x0020,0x0010,0x0008, 0x0004,0x0002,0x0001];
        $chr  = ['r','w','x','r','w','x','r','w','x'];
        $s = '';
        foreach ($bits as $i => $bit) $s .= ($mode & $bit) ? $chr[$i] : '-';
        return $s;
    }

    // full ls-style string for display: type char, rwx, and the setuid/setgid/
    // sticky letters (s/S/t/T). used for the "symbolic" permission view
    private static function permStringFull(int $mode): string
    {
        $fmt  = $mode & 0170000;
        $type = $fmt === 0040000 ? 'd' : ($fmt === 0120000 ? 'l' : ($fmt === 0010000 ? 'p' : ($fmt === 0140000 ? 's' : ($fmt === 0020000 ? 'c' : ($fmt === 0060000 ? 'b' : '-')))));
        $s  = $type;
        $s .= ($mode & 0400 ? 'r' : '-') . ($mode & 0200 ? 'w' : '-') . (($mode & 04000) ? ($mode & 0100 ? 's' : 'S') : ($mode & 0100 ? 'x' : '-'));
        $s .= ($mode & 0040 ? 'r' : '-') . ($mode & 0020 ? 'w' : '-') . (($mode & 02000) ? ($mode & 0010 ? 's' : 'S') : ($mode & 0010 ? 'x' : '-'));
        $s .= ($mode & 0004 ? 'r' : '-') . ($mode & 0002 ? 'w' : '-') . (($mode & 01000) ? ($mode & 0001 ? 't' : 'T') : ($mode & 0001 ? 'x' : '-'));
        return $s;
    }

    // octal permissions for display: three digits normally (750), four only when a
    // setuid/setgid/sticky bit is set (1777), matching how people read modes
    private static function octalPerms(int $mode): string
    {
        $m = $mode & 07777;
        return ($m & 07000) ? sprintf('%04o', $m) : sprintf('%o', $m & 0777);
    }

    // current owner, group and mode of a file or folder, used to seed the owner
    // and permission dialogs. works on a dir too, unlike meta.
    public static function attrs(string $req): array
    {
        $real = self::safePath($req, '');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];
        $st = @stat($real);
        if ($st === false) return ['ok' => false, 'error' => 'cannot read attributes'];
        return [
            'ok'     => true,
            'path'   => $real,
            'is_dir' => is_dir($real),
            'uid'    => (int)$st['uid'],
            'gid'    => (int)$st['gid'],
            'owner'  => self::uidName((int)$st['uid']),
            'group'  => self::gidName((int)$st['gid']),
            'mode'   => sprintf('%04o', $st['mode'] & 07777),
            'perms'  => self::permString($st['mode']),
        ];
    }

    private static function uidName(int $uid): string
    {
        if (function_exists('posix_getpwuid')) { $p = @posix_getpwuid($uid); if ($p && isset($p['name'])) return $p['name']; }
        return (string)$uid;
    }
    private static function gidName(int $gid): string
    {
        if (function_exists('posix_getgrgid')) { $g = @posix_getgrgid($gid); if ($g && isset($g['name'])) return $g['name']; }
        return (string)$gid;
    }

    // ---- text and markdown preview -------------------------------------------
    // reads file content up to a cap for the in-page preview. images, media, pdf
    // and archives are not read here: those are served as bytes or listed
    // separately. binary content is detected and refused so the page never tries
    // to render a blob as text.

    public static function preview(string $req): array
    {
        $real = self::safePath($req, 'file');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];

        $cfg  = self::config();
        $ext  = self::effectiveExt(basename($real));
        $cat  = self::category($ext);
        $size = (int)@filesize($real);

        // only text and markdown are server-rendered; the rest is handled client side
        if ($cat !== 'code' && $cat !== 'md') {
            return ['ok' => true, 'kind' => 'none', 'category' => $cat, 'size' => $size];
        }

        $capBytes = max(64, (int)$cfg['text_cap_kb']) * 1024;
        $fh = @fopen($real, 'rb');
        if ($fh === false) return ['ok' => false, 'error' => 'cannot read file'];
        $content = (string)fread($fh, $capBytes + 1);  // one extra byte tells us if it was longer
        fclose($fh);

        $truncated = strlen($content) > $capBytes;
        if ($truncated) $content = substr($content, 0, $capBytes);

        // a NUL byte in the head means this is not text we should try to render
        if (strpos($content, "\0") !== false) {
            return ['ok' => true, 'kind' => 'binary', 'category' => $cat, 'size' => $size];
        }

        // make sure the payload is valid utf-8 for transport, lossy if it has to be
        if (function_exists('mb_check_encoding') && !mb_check_encoding($content, 'UTF-8')) {
            $content = mb_convert_encoding($content, 'UTF-8', 'UTF-8');
        }

        if ($cat === 'md' && !empty($cfg['md_render'])) {
            return ['ok' => true, 'kind' => 'markdown', 'content' => $content, 'truncated' => $truncated, 'size' => $size];
        }

        return [
            'ok'        => true,
            'kind'      => 'text',
            'language'  => self::hljsLang($ext),
            'content'   => $content,
            'truncated' => $truncated,
            'size'      => $size,
        ];
    }

    // extension to a highlight.js language id where it is unambiguous, else empty
    // and the highlighter auto-detects
    private static function hljsLang(string $ext): string
    {
        static $map = [
            'php'=>'php','js'=>'javascript','ts'=>'typescript','json'=>'json','xml'=>'xml',
            'html'=>'xml','css'=>'css','py'=>'python','rb'=>'ruby','go'=>'go','rs'=>'rust',
            'c'=>'c','h'=>'c','cpp'=>'cpp','sql'=>'sql','sh'=>'bash','bash'=>'bash',
            'yml'=>'yaml','yaml'=>'yaml','ini'=>'ini','conf'=>'ini','cfg'=>'ini',
            'md'=>'markdown','markdown'=>'markdown',
        ];
        return $map[strtolower($ext)] ?? '';
    }

    // ---- archive contents (listing only, never extracted) --------------------
    // shells out to a list-only command picked by the file suffix. the path is
    // the single argument and is escaped, the flags never extract, output is
    // bounded, and unknown archive types are reported rather than guessed.

    public static function archiveList(string $req): array
    {
        $real = self::safePath($req, 'file');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];

        $cfg   = self::config();
        $max   = max(50, (int)$cfg['archive_max']);
        $lower = strtolower(basename($real));
        $arg   = escapeshellarg($real);

        // an archive can sit behind a trailing suffix like backup.zip.071.bak.
        // drop trailing dot segments until the name ends in a known archive form,
        // keeping compound endings like .tar.gz intact for the checks below.
        $archEnd = ['.zip','.tar','.tar.gz','.tgz','.tar.bz2','.tbz','.tbz2','.tar.xz','.txz','.gz','.bz2','.xz','.7z','.rar'];
        $scan = $lower;
        while (strpos($scan, '.') !== false) {
            $hit = false;
            foreach ($archEnd as $ae) { if (str_ends_with($scan, $ae)) { $hit = true; break; } }
            if ($hit) break;
            $scan = substr($scan, 0, strrpos($scan, '.'));
        }

        $mode = '';
        if (str_ends_with($scan, '.zip')) {
            $cmd = 'unzip -l ' . $arg; $mode = 'zip';
        } elseif (str_ends_with($scan, '.tar')) {
            $cmd = 'tar -tvf ' . $arg; $mode = 'tar';
        } elseif (str_ends_with($scan, '.tar.gz') || str_ends_with($scan, '.tgz')) {
            $cmd = 'tar -tzvf ' . $arg; $mode = 'tar';
        } elseif (str_ends_with($scan, '.tar.bz2') || str_ends_with($scan, '.tbz') || str_ends_with($scan, '.tbz2')) {
            $cmd = 'tar -tjvf ' . $arg; $mode = 'tar';
        } elseif (str_ends_with($scan, '.tar.xz') || str_ends_with($scan, '.txz')) {
            $cmd = 'tar -tJvf ' . $arg; $mode = 'tar';
        } else {
            // 7z, rar and standalone gz/bz2/xz need tools we do not assume are present
            return ['ok' => true, 'kind' => 'arch_unsupported', 'category' => 'arch', 'size' => (int)@filesize($real)];
        }

        // timeout guards a pathological archive, head bounds the output volume
        $full  = 'timeout 20 ' . $cmd . ' 2>/dev/null | head -n ' . ($max + 40);
        $lines = [];
        @exec($full, $lines);

        $entries = [];
        foreach ($lines as $ln) {
            if ($mode === 'zip') {
                // length  date  time  name
                if (preg_match('/^\s*(\d+)\s+\d{4}-\d\d-\d\d\s+\d\d:\d\d\s+(.+)$/', $ln, $m)) {
                    $nm = $m[2];
                    $entries[] = ['name' => $nm, 'size' => (int)$m[1], 'is_dir' => (substr($nm, -1) === '/')];
                }
            } else {
                // tar verbose: perms owner/group size date time name
                if (preg_match('#^([dl\-][rwxsStT\-]{9})\S*\s+\S+\s+(\d+)\s+\d{4}-\d\d-\d\d\s+\d\d:\d\d\s+(.+)$#', $ln, $m)) {
                    $nm    = $m[3];
                    $isDir = ($m[1][0] === 'd') || (substr($nm, -1) === '/');
                    $arrow = strpos($nm, ' -> ');         // symlinks show as "name -> target"
                    if ($arrow !== false) $nm = substr($nm, 0, $arrow);
                    $entries[] = ['name' => $nm, 'size' => (int)$m[2], 'is_dir' => $isDir];
                }
            }
            if (count($entries) >= $max) break;
        }

        return [
            'ok'        => true,
            'kind'      => 'archive',
            'category'  => 'arch',
            'count'     => count($entries),
            'truncated' => (count($entries) >= $max),
            'entries'   => $entries,
        ];
    }

    // ---- write gate -----------------------------------------------------------
    // every write passes through here: POST only, the csrf check in run(), the
    // path resolved and kept inside the roots, a root mount never the target of a
    // destructive op, and a line in the audit log. the operations themselves land
    // over the next phases; this is the seam they share.

    private const WRITE_ACTIONS = ['create','rename','delete','save','move','copy','chmod','chown','upload','upload_cancel','job_cancel','recycle_restore','recycle_purge','space_start'];
    private const AUDIT_LOG     = '/var/log/filesviewer.log';
    private const EDIT_MAX_BYTES = 2097152;   // 2 MiB cap for in-browser editing

    private static int  $obBase = 0;      // output buffer level on entry
    private static bool $obOn   = false;  // we trapped output, respond drops it
    private static bool $responded = false; // a body was written; shutdown guard checks this

    public static function isWriteAction(string $action): bool
    {
        return in_array($action, self::WRITE_ACTIONS, true);
    }

    // a write must never ride on GET, so a stray link or a prefetch cannot mutate the disk
    private static function requirePost(): bool
    {
        return ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST';
    }

    // one path component the user supplied (new file, rename target). no
    // separators, no dot-dirs, no control bytes, length kept sane.
    public static function safeName(string $name): ?string
    {
        $name = trim($name);
        if ($name === '' || $name === '.' || $name === '..') return null;
        if (strlen($name) > 255) return null;
        if (strpbrk($name, "/\\") !== false) return null;                       // no path separators
        for ($i = 0, $n = strlen($name); $i < $n; $i++) {                       // no control bytes
            if (ord($name[$i]) < 0x20) return null;
        }
        return $name;
    }

    // for a path that does not exist yet (create, or the destination of a
    // move/copy/rename): vet the leaf as a name and require the parent to be a
    // real dir inside the roots. realpath cannot vet the leaf since it is not
    // there yet, so the parent is what we confine.
    public static function safeNewPath(string $parentReq, string $name): ?array
    {
        $dir = self::safePath($parentReq, 'dir');
        if ($dir === null) return null;
        $leaf = self::safeName($name);
        if ($leaf === null) return null;
        return ['dir' => $dir, 'name' => $leaf, 'path' => $dir . DIRECTORY_SEPARATOR . $leaf];
    }

    // a root mount itself is never a valid target for delete/rename/move
    public static function isRootPath(string $real): bool
    {
        foreach (self::allowedRoots() as $root) {
            if ($real === $root) return true;
        }
        return false;
    }

    // terse audit line per write. /var/log is tmpfs on unraid, so this is a
    // session trail, not a permanent record. the recycle bin is the durable net.
    private static function audit(string $action, array $fields): void
    {
        $parts = [date('Y-m-d H:i:s'), $action];
        foreach ($fields as $k => $v) $parts[] = $k . '=' . str_replace(["\n","\r"], ' ', (string)$v);
        @file_put_contents(self::AUDIT_LOG, implode('  ', $parts) . "\n", FILE_APPEND | LOCK_EX);
    }

    // if the script dies before respond() (a fatal that skips the try/catch, e.g.
    // a memory or limit error), turn the otherwise empty 200 body into a json
    // error carrying the real reason, so the ui can show it instead of "HTTP 200"
    public static function shutdownGuard(): void
    {
        if (self::$responded) return;
        $e = error_get_last();
        while (ob_get_level() > self::$obBase) @ob_end_clean();
        if (!headers_sent()) {
            http_response_code(500);
            header('Content-Type: application/json; charset=utf-8');
        }
        $fatal = [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR, E_RECOVERABLE_ERROR];
        $msg = ($e && in_array($e['type'], $fatal, true))
            ? ($e['message'] . ' @ ' . basename((string)($e['file'] ?? '')) . ':' . ($e['line'] ?? 0))
            : 'request ended with no response';
        echo json_encode(['ok' => false, 'error' => 'server stopped: ' . $msg],
            JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    }

    // one json writer for every action, so the shape and flags stay uniform
    private static function respond(array $payload, int $code = 200): void
    {
        self::$responded = true;
        if (self::$obOn) {
            while (ob_get_level() > self::$obBase) ob_end_clean();   // drop trapped warnings/notices
            self::$obOn = false;
        }
        if (!headers_sent()) {
            if ($code !== 200) http_response_code($code);
            header('Content-Type: application/json; charset=utf-8');
        }
        echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    }

    // ---- background jobs ------------------------------------------------------
    // a long copy/move/delete cannot finish inside one request, so it runs
    // detached and writes progress to a status file the ui polls. this is the
    // scaffold: id, status read/merge, spawn, and the status action. the worker
    // walks the tree and fills the counters in a later phase. jobNewId and
    // jobSpawn have no caller yet; they fix the handoff the copy/move phase uses.

    public static function jobsBaseDir(): string { return '/tmp/filesviewer/jobs'; }

    private static function jobNewId(): string { return bin2hex(random_bytes(8)); }

    // confine to hex ids, so an id from the client can never point outside the dir
    public static function jobDir(string $id): ?string
    {
        if (!preg_match('/^[a-f0-9]{16}$/', $id)) return null;
        return self::jobsBaseDir() . '/' . $id;
    }

    public static function jobRead(string $id): ?array
    {
        $dir = self::jobDir($id);
        if ($dir === null) return null;
        $raw = @file_get_contents($dir . '/status.json');
        if ($raw === false) return null;
        $d = json_decode($raw, true);
        return is_array($d) ? $d : null;
    }

    // read, merge, write atomically: a poll never reads a half file and a partial
    // update keeps the running counters
    public static function jobPatch(string $id, array $patch): bool
    {
        $dir = self::jobDir($id);
        if ($dir === null) return false;
        if (!is_dir($dir) && !@mkdir($dir, 0700, true)) return false;
        $next = array_merge(self::jobRead($id) ?: [], $patch, ['updated' => time()]);
        $tmp  = $dir . '/.status.' . getmypid();
        if (@file_put_contents($tmp, json_encode($next, JSON_UNESCAPED_SLASHES)) === false) return false;
        return @rename($tmp, $dir . '/status.json');
    }

    // hand the spec over in the job dir, so no untrusted data rides on the command
    // line, then launch the worker detached
    private static function jobSpawn(string $id, array $spec): bool
    {
        $dir = self::jobDir($id);
        if ($dir === null) return false;
        if (!self::jobPatch($id, ['state' => 'queued', 'total' => 0, 'done' => 0, 'current' => '', 'message' => '', 'started' => time()])) return false;
        if (@file_put_contents($dir . '/spec.json', json_encode($spec, JSON_UNESCAPED_SLASHES)) === false) return false;
        @exec('php ' . escapeshellarg(__DIR__ . '/filesviewer_worker.php') . ' ' . escapeshellarg($id) . ' > /dev/null 2>&1 &');
        return true;
    }

    private function jobStatusAction(string $id): void
    {
        $st = self::jobRead($id);
        if ($st === null) { self::respond(['ok' => false, 'error' => 'no such job'], 404); return; }
        self::respond(['ok' => true, 'job' => $id, 'status' => $st]);
    }

    // ---- create / rename / delete (phase 1) -----------------------------------

    // new empty file or folder inside an allowed parent. never clobbers an
    // existing entry. the entry inherits the parent owner, group and mode, so it
    // matches the share around it instead of landing root-owned.
    private static function opCreate(): array
    {
        $parent = (string)($_POST['parent'] ?? '');
        $name   = (string)($_POST['name'] ?? '');
        $kind   = (string)($_POST['kind'] ?? 'file');

        $t = self::safeNewPath($parent, $name);
        if ($t === null) return ['ok' => false, 'error' => 'invalid name or location'];
        if (file_exists($t['path'])) return ['ok' => false, 'error' => 'an item with that name already exists'];

        if ($kind === 'dir') {
            if (!@mkdir($t['path'], 0755)) return ['ok' => false, 'error' => 'could not create the folder'];
        } else {
            $fh = @fopen($t['path'], 'x');                 // x fails if it appeared in the meantime
            if ($fh === false) return ['ok' => false, 'error' => 'could not create the file'];
            fclose($fh);
        }

        self::inheritParent($t['path'], $t['dir'], $kind === 'dir');
        self::audit('create', ['kind' => $kind, 'path' => $t['path']]);
        return ['ok' => true, 'path' => $t['path'], 'name' => $t['name']];
    }

    // best effort: copy the parent owner/group and a sane mode onto a new entry
    private static function inheritParent(string $path, string $parent, bool $isDir): void
    {
        $st = @stat($parent);
        if ($st === false) return;
        @chown($path, $st['uid']);
        @chgrp($path, $st['gid']);
        $mode = $st['mode'] & 0777;
        if (!$isDir) $mode &= 0666;                        // a new file is not executable
        @chmod($path, $mode);
    }

    // rename in place, within the same folder. refuses a root mount and never
    // clobbers an existing name.
    private static function opRename(): array
    {
        $path = (string)($_POST['path'] ?? '');
        $name = (string)($_POST['name'] ?? '');

        $real = self::safePath($path, '');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];
        if (self::isRootPath($real)) return ['ok' => false, 'error' => 'cannot rename a root'];

        $leaf = self::safeName($name);
        if ($leaf === null) return ['ok' => false, 'error' => 'invalid name'];

        $dest = dirname($real) . DIRECTORY_SEPARATOR . $leaf;
        if ($dest === $real) return ['ok' => true, 'path' => $real, 'name' => basename($real)];
        if (file_exists($dest)) return ['ok' => false, 'error' => 'an item with that name already exists'];

        if (!@rename($real, $dest)) return ['ok' => false, 'error' => 'rename failed'];
        self::audit('rename', ['from' => $real, 'to' => $dest]);
        return ['ok' => true, 'path' => $dest, 'name' => $leaf];
    }

    // delete one or more items. the default mode moves them into the share's
    // recycle bin as one event; permanent removes them for good. refuses roots.
    private static function opDelete(): array
    {
        $mode = (string)($_POST['mode'] ?? 'permanent');

        $list = [];
        $raw  = (string)($_POST['paths'] ?? '');
        if ($raw !== '') {
            $dec = json_decode($raw, true);
            if (!is_array($dec)) return ['ok' => false, 'error' => 'bad paths'];
            foreach ($dec as $p) if (is_string($p) && $p !== '') $list[] = $p;
        } else {
            $p = (string)($_POST['path'] ?? '');
            if ($p !== '') $list[] = $p;
        }
        if (!$list) return ['ok' => false, 'error' => 'nothing to delete'];

        $reals = [];
        foreach ($list as $p) {
            $real = self::safePath($p, '');
            if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];
            if (self::isRootPath($real)) return ['ok' => false, 'error' => 'cannot delete a root'];
            $reals[] = $real;
        }

        if ($mode === 'trash') return self::opTrash($reals);

        @set_time_limit(0);                                // a large tree must not be cut off mid-delete
        $failed = [];
        foreach ($reals as $real) {
            if (!self::removeTree($real)) { $failed[] = basename($real); continue; }
            self::audit('delete', ['mode' => 'permanent', 'path' => $real]);
        }
        return ['ok' => count($failed) < count($reals), 'deleted' => count($reals) - count($failed), 'failed' => $failed]
             + ($failed && count($failed) === count($reals) ? ['error' => 'delete failed or incomplete'] : []);
    }

    // recursive remove. a symlink is unlinked, never followed, so the delete can
    // never walk out of the tree through a link.
    private static function removeTree(string $path): bool
    {
        if (is_link($path) || !is_dir($path)) return @unlink($path);

        $ok = true;
        foreach (scandir($path) ?: [] as $e) {
            if ($e === '.' || $e === '..') continue;
            $ok = self::removeTree($path . DIRECTORY_SEPARATOR . $e) && $ok;
        }
        return @rmdir($path) && $ok;
    }

    // ---- sqlite browser (read only) ---------------------------------------------
    // opens database files with immutable=1 over a readonly uri: no locks are
    // taken and nothing is ever written, so a live application database cannot be
    // disturbed. the price is honesty about wal: changes still sitting in the
    // write ahead log are not visible, and a read can fail cleanly while the
    // owner is writing. both outcomes are safe.

    private const DB_EXTS = ['db', 'db3', 'sqlite', 'sqlite3'];

    private static function sqliteEngine(): ?string
    {
        // pdo first: it accepts uri filenames, so the immutable open (no locks,
        // no writes, safe next to a live application) is available. the SQLite3
        // class does not parse uris in this php build, so it is the fallback,
        // opened plain readonly: never writes, but takes shared read locks
        if (class_exists('PDO') && in_array('sqlite', PDO::getAvailableDrivers(), true)) return 'pdo';
        if (class_exists('SQLite3')) return 'sqlite3';
        return null;
    }

    private static function sqliteMagic(string $real): bool
    {
        $h = @fopen($real, 'rb');
        if ($h === false) return false;
        $sig = fread($h, 16);
        fclose($h);
        return $sig === "SQLite format 3\x00";
    }

    // sqlite uri: keep the slashes, escape what would break the query part
    private static function sqliteUri(string $real): string
    {
        return 'file:' . str_replace(['%', '#', '?'], ['%25', '%23', '%3F'], $real) . '?mode=ro&immutable=1';
    }

    private static function sqliteOpen(string $real, ?string &$err, ?bool &$immutable = null)
    {
        $err = null; $immutable = false;
        try {
            if (self::sqliteEngine() === 'pdo') {
                $c = new PDO('sqlite:' . self::sqliteUri($real));
                $c->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
                $c->setAttribute(PDO::ATTR_TIMEOUT, 1);
                $immutable = true;
                return $c;
            }
            // some sqlite builds honour uris without the open flag (SQLITE_USE_URI):
            // probe the immutable open first, fall back to plain readonly. a failed
            // probe cannot create anything since the mode is readonly
            try {
                $c = new SQLite3(self::sqliteUri($real), SQLITE3_OPEN_READONLY);
                $c->enableExceptions(true);
                $c->querySingle('select 1');
                $immutable = true;
                return $c;
            } catch (Throwable $e) {}
            $c = new SQLite3($real, SQLITE3_OPEN_READONLY);
            $c->busyTimeout(400);
            $c->enableExceptions(true);
            return $c;
        } catch (Throwable $e) {
            $err = $e->getMessage();
            return null;
        }
    }

    // columns and rows as plain arrays, whichever engine is present
    private static function sqAll($c, string $sql, array $bind = []): array
    {
        if ($c instanceof SQLite3) {
            $st = $c->prepare($sql);
            foreach ($bind as $i => $v) $st->bindValue($i + 1, $v);
            $res = $st->execute();
            $cols = [];
            for ($i = 0; $i < $res->numColumns(); $i++) $cols[] = $res->columnName($i);
            $rows = [];
            while (($r = $res->fetchArray(SQLITE3_NUM)) !== false) $rows[] = $r;
            return [$cols, $rows];
        }
        $st = $c->prepare($sql);
        $st->execute($bind);
        $rows = $st->fetchAll(PDO::FETCH_NUM);
        $cols = [];
        for ($i = 0; $i < $st->columnCount(); $i++) { $m = $st->getColumnMeta($i); $cols[] = (string)($m['name'] ?? ('col' . $i)); }
        return [$cols, $rows];
    }

    private static function dbPathOk(string $path, ?string &$err): ?string
    {
        $real = self::safePath($path, 'file');
        if ($real === null) { $err = 'path not allowed'; return null; }
        if (!in_array(self::effectiveExt(basename($real)), self::DB_EXTS, true)) { $err = 'not a database file'; return null; }
        if (!self::sqliteMagic($real)) { $err = 'not an SQLite database'; return null; }
        return $real;
    }

    public static function dbInfo(string $path): array
    {
        $eng = self::sqliteEngine();
        if ($eng === null) return ['ok' => false, 'error' => 'no SQLite support in this PHP build'];
        $real = self::dbPathOk($path, $err);
        if ($real === null) return ['ok' => false, 'error' => $err];

        $wal = is_file($real . '-wal') && (int)@filesize($real . '-wal') > 0;
        $c = self::sqliteOpen($real, $err, $imm);
        if ($c === null) {
            return ['ok' => false, 'error' => 'cannot open: ' . $err .
                ($wal ? ' (a write ahead log is present; the database may be mid write or left over from a crash)' : '')];
        }

        try {
            [, $vr] = self::sqAll($c, 'select sqlite_version()');
            [, $tr] = self::sqAll($c, "select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name");

            $tables = [];
            $budget = microtime(true) + 3.0;      // row counts stop politely on huge libraries
            $trunc  = false;
            foreach ($tr as $t) {
                $name = (string)$t[0];
                $kind = (string)$t[1];
                [, $ci] = self::sqAll($c, 'select count(*) from pragma_table_info(?)', [$name]);
                $rows = null;
                if ($kind === 'table') {
                    if (microtime(true) < $budget) {
                        $q = '"' . str_replace('"', '""', $name) . '"';
                        try { [, $rc] = self::sqAll($c, 'select count(*) from ' . $q); $rows = (int)$rc[0][0]; }
                        catch (Throwable $e) { $rows = null; }
                    } else { $trunc = true; }
                }
                $tables[] = ['name' => $name, 'kind' => $kind, 'cols' => (int)($ci[0][0] ?? 0), 'rows' => $rows];
            }
        } catch (Throwable $e) {
            return ['ok' => false, 'error' => 'read failed: ' . $e->getMessage() . ($wal ? ' (the database is in wal mode and may be busy)' : '')];
        }

        return ['ok' => true, 'kind' => 'sqlite', 'engine' => $eng, 'immutable' => (bool)$imm,
                'sqlite' => (string)($vr[0][0] ?? ''), 'size' => (int)@filesize($real),
                'wal' => $wal, 'tables' => $tables, 'counts_partial' => $trunc];
    }

    public static function dbRows(string $path): array
    {
        $eng = self::sqliteEngine();
        if ($eng === null) return ['ok' => false, 'error' => 'no SQLite support in this PHP build'];
        $real = self::dbPathOk($path, $err);
        if ($real === null) return ['ok' => false, 'error' => $err];

        $table = (string)($_GET['table'] ?? '');
        $off   = max(0, (int)($_GET['offset'] ?? 0));
        $lim   = (int)($_GET['limit'] ?? 100);
        $lim   = max(1, min(200, $lim));

        $wal = is_file($real . '-wal') && (int)@filesize($real . '-wal') > 0;
        $c = self::sqliteOpen($real, $err);
        if ($c === null) {
            return ['ok' => false, 'error' => 'cannot open: ' . $err .
                ($wal ? ' (a write ahead log is present; the database may be mid write or left over from a crash)' : '')];
        }

        try {
            // the name is trusted only after an exact match in sqlite_master, then
            // quoted as an identifier. nothing from the client lands in sql raw
            [, $ex] = self::sqAll($c, "select 1 from sqlite_master where type in ('table','view') and name = ?", [$table]);
            if (!$ex) return ['ok' => false, 'error' => 'no such table'];
            $q = '"' . str_replace('"', '""', $table) . '"';
            [$cols, $rows] = self::sqAll($c, 'select * from ' . $q . ' limit ' . ($lim + 1) . ' offset ' . $off);
        } catch (Throwable $e) {
            return ['ok' => false, 'error' => 'read failed: ' . $e->getMessage() . ($wal ? ' (the database is in wal mode and may be busy)' : '')];
        }

        $more = count($rows) > $lim;
        if ($more) array_pop($rows);
        foreach ($rows as &$r) { foreach ($r as &$v) { $v = self::dbCell($v); } }
        unset($r, $v);

        return ['ok' => true, 'table' => $table, 'columns' => $cols, 'rows' => $rows,
                'offset' => $off, 'limit' => $lim, 'more' => $more];
    }

    // json friendly cell: blobs become a size tag, long text is clipped
    private static function dbCell($v)
    {
        if ($v === null || is_int($v) || is_float($v)) return $v;
        $s = (string)$v;
        if ($s !== '' && !preg_match('//u', $s)) return '[blob ' . strlen($s) . ' B]';
        if (strlen($s) > 300) return substr($s, 0, 300) . '...';
        return $s;
    }

    // ---- space analysis (start) -----------------------------------------------
    // read only: ranks the direct children of a folder by the disk space they
    // hold. the walk runs in the detached worker as a job, so the gui polls
    // job_status and can cancel it like a copy
    private static function opSpaceStart(): array
    {
        $real = self::safePath((string)($_POST['path'] ?? ''), 'dir');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];
        if (self::isRootPath($real)) return ['ok' => false, 'error' => 'pick a folder inside a root'];

        $id = self::jobNewId();
        if (!self::jobSpawn($id, ['op' => 'space', 'path' => $real])) {
            return ['ok' => false, 'error' => 'cannot start the scan'];
        }
        self::audit('space', ['path' => $real, 'job' => $id]);
        return ['ok' => true, 'id' => $id];
    }

    // ---- recycle bin ----------------------------------------------------------
    // a trash is a rename into <share>/.RecycleBin/<event>/ on the same
    // filesystem, so it is instant and atomic at any size and never copies data.
    // each delete run is one event folder holding the items under their share
    // relative paths plus a meta.json that drives restore.
    // the bin is reachable from this ui only: samba vetoes the folder name
    // globally (managed block in smb-extra.conf, written by the plg) and the
    // folder itself is root 0700, which also covers nfs.

    private const BIN_DIR  = '.RecycleBin';
    private const EVENT_RX = '/^\d{8}-\d{6}-[a-z0-9]{6}$/';

    // share level root that owns a path: /mnt/<top>/<share>. null when the path
    // is too shallow (roots, tops, or the share itself), where only a permanent
    // delete makes sense
    private static function binShareRoot(string $real): ?string
    {
        $parts = array_values(array_filter(explode('/', $real), 'strlen'));
        if (count($parts) < 4 || $parts[0] !== 'mnt') return null;
        return '/mnt/' . $parts[1] . '/' . $parts[2];
    }

    // same, but for a browse location where the share folder itself counts
    private static function binScopeRoot(string $real): ?string
    {
        $parts = array_values(array_filter(explode('/', $real), 'strlen'));
        if (count($parts) < 3 || $parts[0] !== 'mnt') return null;
        return '/mnt/' . $parts[1] . '/' . $parts[2];
    }

    private static function inheritDir(string $dir, $basis): void
    {
        if ($basis === false) return;
        @chown($dir, $basis['uid']); @chgrp($dir, $basis['gid']); @chmod($dir, $basis['mode'] & 0777);
    }

    // create every missing level of $rel under $base, inheriting the share owner
    private static function makeDirsInherit(string $base, string $rel, $basis): ?string
    {
        $cur = $base;
        foreach (array_filter(explode('/', $rel), 'strlen') as $seg) {
            if ($seg === '.' || $seg === '..') return null;
            $cur .= '/' . $seg;
            if (!is_dir($cur)) {
                @mkdir($cur);
                if (!is_dir($cur)) return null;
                self::inheritDir($cur, $basis);
            }
        }
        return $cur;
    }

    private static function opTrash(array $reals): array
    {
        if (!self::config()['recycle']) return ['ok' => false, 'error' => 'recycle bin is disabled'];

        $shareRoot = null;
        foreach ($reals as $real) {
            if (basename($real) === self::BIN_DIR || strpos($real . '/', '/' . self::BIN_DIR . '/') !== false) {
                return ['ok' => false, 'error' => 'already in the recycle bin, delete there is permanent'];
            }
            $sr = self::binShareRoot($real);
            if ($sr === null) return ['ok' => false, 'error' => 'only a permanent delete works at this level'];
            if ($shareRoot === null) $shareRoot = $sr;
            elseif ($sr !== $shareRoot) return ['ok' => false, 'error' => 'items span different shares'];
        }
        if (!is_dir($shareRoot)) return ['ok' => false, 'error' => 'share root not found'];

        $basis = @stat($shareRoot);
        $bin   = $shareRoot . '/' . self::BIN_DIR;
        if (!is_dir($bin)) {
            @mkdir($bin);
            if (!is_dir($bin)) return ['ok' => false, 'error' => 'cannot create the recycle bin'];
        }
        // root 0700 keeps smb and nfs out even where the veto is overridden per
        // share; enforcing it on every trash also heals bins from older builds
        @chown($bin, 0); @chgrp($bin, 0); @chmod($bin, 0700);

        // the whole point of the design: a trash must be a same filesystem
        // rename. anything else would mean copying data, so it is refused
        $bs = @stat($bin);
        foreach ($reals as $real) {
            $ps = @stat(dirname($real));
            if ($bs === false || $ps === false || $bs['dev'] !== $ps['dev']) {
                return ['ok' => false, 'error' => 'recycle bin is on a different filesystem, use a permanent delete'];
            }
        }

        $id = date('Ymd-His') . '-' . substr(str_shuffle('abcdefghijklmnopqrstuvwxyz0123456789'), 0, 6);
        $ev = $bin . '/' . $id;
        if (!@mkdir($ev)) return ['ok' => false, 'error' => 'cannot create the event folder'];
        self::inheritDir($ev, $basis);

        $items = []; $failed = [];
        foreach ($reals as $real) {
            $rel    = ltrim(substr($real, strlen($shareRoot)), '/');
            $parent = dirname($rel);
            $dest   = ($parent === '.') ? $ev : self::makeDirsInherit($ev, $parent, $basis);
            if ($dest === null) { $failed[] = basename($real); continue; }
            $st    = @lstat($real);
            $isDir = is_dir($real) && !is_link($real);
            if (!@rename($real, $ev . '/' . $rel)) { $failed[] = basename($real); continue; }
            $items[] = ['rel' => $rel, 'original' => $real, 'is_dir' => $isDir,
                        'size' => ($isDir || $st === false) ? null : (int)$st['size']];
        }

        if (!$items) { @rmdir($ev); return ['ok' => false, 'error' => 'nothing could be moved', 'failed' => $failed]; }

        $mf = $ev . '/meta.json';
        @file_put_contents($mf, json_encode([
            'version' => 1, 'deleted_at' => time(), 'share_root' => $shareRoot, 'items' => $items,
        ], JSON_UNESCAPED_SLASHES));
        if ($basis !== false) { @chown($mf, $basis['uid']); @chgrp($mf, $basis['gid']); @chmod($mf, 0644); }

        self::audit('delete', ['mode' => 'trash', 'event' => $ev, 'items' => count($items)]);
        return ['ok' => true, 'mode' => 'trash', 'event' => $id, 'moved' => count($items), 'failed' => $failed];
    }

    // bins to look at for a scope: the current share, or every share style top
    // across the array, pools and mounted devices. user0 is skipped as a legacy
    // duplicate of user
    private static function recycleBins(string $scope, string $path): array
    {
        if ($scope === 'share') {
            $real = self::safePath($path, 'dir');
            $sr   = ($real !== null) ? self::binScopeRoot($real) : null;
            if ($sr === null) return [];
            $b = $sr . '/' . self::BIN_DIR;
            return is_dir($b) ? [$b] : [];
        }
        $out = [];
        foreach ((array)glob('/mnt/*/*/' . self::BIN_DIR, GLOB_NOSORT) as $b) {
            if (strpos($b, '/mnt/user0/') === 0) continue;
            if (is_dir($b)) $out[$b] = true;
        }
        return array_keys($out);
    }

    public static function recycleList(): array
    {
        $scope = ((string)($_GET['scope'] ?? 'share')) === 'all' ? 'all' : 'share';
        $bins  = self::recycleBins($scope, (string)($_GET['path'] ?? ''));

        $events = [];
        foreach ($bins as $bin) {
            foreach (scandir($bin, SCANDIR_SORT_DESCENDING) ?: [] as $e) {
                if (!preg_match(self::EVENT_RX, $e)) continue;
                $ed = $bin . '/' . $e;
                if (!is_dir($ed)) continue;
                $meta  = json_decode((string)@file_get_contents($ed . '/meta.json'), true);
                $items = is_array($meta['items'] ?? null) ? $meta['items'] : [];
                $names = []; $size = 0; $sized = true;
                foreach ($items as $it) {
                    $names[] = basename((string)($it['rel'] ?? ''));
                    if (isset($it['size'])) $size += (int)$it['size']; else $sized = false;
                }
                $row = [
                    'id'         => $e,
                    'event'      => $ed,
                    'share'      => basename(dirname($bin)),
                    'origin'     => dirname($bin),
                    'deleted_at' => (int)($meta['deleted_at'] ?? @filemtime($ed)),
                    'count'      => count($items),
                    'kind'       => count($items) === 1 ? (!empty($items[0]['is_dir']) ? 'dir' : 'file') : 'multi',
                    'names'      => array_slice($names, 0, 3),
                    'size'       => $size,
                    'size_partial' => !$sized,
                ];
                // the same physical event can show through /mnt/user and a disk
                // path at once; the user view wins
                if (!isset($events[$e]) || strpos($ed, '/mnt/user/') === 0) $events[$e] = $row;
            }
        }
        krsort($events);
        $rows  = array_values($events);
        $trunc = count($rows) > 500;
        if ($trunc) $rows = array_slice($rows, 0, 500);

        $cfg = self::config();
        return ['ok' => true, 'events' => $rows, 'truncated' => $trunc,
                'enabled' => $cfg['recycle'], 'days' => $cfg['recycle_days']];
    }

    // an event reference from the client is trusted only after it resolves to
    // exactly <mnt>/<top>/<share>/.RecycleBin/<id>
    private static function eventPath(string $req): ?string
    {
        if ($req === '' || strpos($req, "\0") !== false || strpos($req, '..') !== false) return null;
        $rp = @realpath($req);
        if ($rp === false) return null;
        $rx = '#^/mnt/[^/]+/[^/]+/' . preg_quote(self::BIN_DIR, '#') . '/\d{8}-\d{6}-[a-z0-9]{6}$#';
        return preg_match($rx, $rp) ? $rp : null;
    }

    public static function recycleRestore(): array
    {
        $ev = self::eventPath((string)($_POST['event'] ?? ''));
        if ($ev === null) return ['ok' => false, 'error' => 'event not found'];

        $shareRoot = dirname(dirname($ev));
        $meta  = json_decode((string)@file_get_contents($ev . '/meta.json'), true);
        $items = is_array($meta['items'] ?? null) ? $meta['items'] : null;
        if (!$items) return ['ok' => false, 'error' => 'event metadata is missing'];

        $basis = @stat($shareRoot);
        $done = 0; $failed = []; $left = [];
        foreach ($items as $it) {
            $rel  = (string)($it['rel'] ?? '');
            $dest = (string)($it['original'] ?? '');
            // tampered metadata must not steer a rename outside this share
            if ($rel === '' || strpos($rel, '..') !== false ||
                strpos($dest, '..') !== false || strpos($dest, $shareRoot . '/') !== 0) {
                $failed[] = $rel; $left[] = $it; continue;
            }
            $src = $ev . '/' . $rel;
            if (!@file_exists($src) && !@is_link($src)) { $failed[] = $rel . ' - missing'; continue; }
            $dp = dirname($dest);
            if (!is_dir($dp) &&
                self::makeDirsInherit($shareRoot, ltrim(substr($dp, strlen($shareRoot)), '/'), $basis) === null) {
                $failed[] = $rel; $left[] = $it; continue;
            }
            if (file_exists($dest) || is_link($dest)) $dest = self::freeNamePath($dp, basename($dest));
            if (!@rename($src, $dest)) { $failed[] = $rel; $left[] = $it; continue; }
            $done++;
        }

        if (!$left) {
            self::removeTree($ev);
            self::binTidy(dirname($ev));
        } else {
            @file_put_contents($ev . '/meta.json', json_encode([
                'version' => 1, 'deleted_at' => (int)($meta['deleted_at'] ?? time()),
                'share_root' => $shareRoot, 'items' => $left,
            ], JSON_UNESCAPED_SLASHES));
        }

        self::audit('recycle_restore', ['event' => $ev, 'restored' => $done, 'failed' => count($failed)]);
        if (!$done) return ['ok' => false, 'error' => 'nothing could be restored', 'failed' => $failed];
        return ['ok' => true, 'restored' => $done, 'failed' => $failed];
    }

    public static function recyclePurge(): array
    {
        $mode = (string)($_POST['mode'] ?? '');
        @set_time_limit(0);

        if ($mode === 'event') {
            $ev = self::eventPath((string)($_POST['event'] ?? ''));
            if ($ev === null) return ['ok' => false, 'error' => 'event not found'];
            if (!self::removeTree($ev)) return ['ok' => false, 'error' => 'purge failed or incomplete'];
            self::binTidy(dirname($ev));
            self::audit('recycle_purge', ['event' => $ev]);
            return ['ok' => true, 'purged' => 1];
        }
        if ($mode !== 'expired' && $mode !== 'all') return ['ok' => false, 'error' => 'bad purge mode'];

        $scope = ((string)($_POST['scope'] ?? 'all')) === 'share' ? 'share' : 'all';
        $bins  = self::recycleBins($scope, (string)($_POST['path'] ?? ''));
        $days  = self::config()['recycle_days'];

        // never means nothing ages out: an expired sweep is a no-op, while an
        // explicit empty (mode all) still clears the bin
        if ($mode === 'expired' && $days === 'never') return ['ok' => true, 'purged' => 0];
        $cut = time() - (int)$days * 86400;

        $n = 0; $bad = 0;
        foreach ($bins as $bin) {
            foreach (scandir($bin) ?: [] as $e) {
                if (!preg_match(self::EVENT_RX, $e)) continue;
                $ed = $bin . '/' . $e;
                if (!file_exists($ed) && !is_link($ed)) continue;   // already gone through another view of the same share
                if ($mode === 'expired' && self::eventTime($e, $ed) > $cut) continue;
                if (self::removeTree($ed)) $n++; else $bad++;
            }
            self::binTidy($bin);
        }
        self::audit('recycle_purge', ['mode' => $mode, 'purged' => $n]);
        return $bad ? ['ok' => false, 'error' => 'some events could not be purged', 'purged' => $n]
                    : ['ok' => true, 'purged' => $n];
    }

    private static function eventTime(string $id, string $dir): int
    {
        $dt = DateTime::createFromFormat('Ymd-His', substr($id, 0, 15));
        return $dt ? $dt->getTimestamp() : (int)@filemtime($dir);
    }

    // drop an empty bin folder so shares stay clean; it comes back on the next trash
    private static function binTidy(string $bin): void
    {
        if (!is_dir($bin)) return;
        $rest = array_diff(scandir($bin) ?: [], ['.', '..']);
        if (!$rest) @rmdir($bin);
    }

    // ---- edit (phase 2) -------------------------------------------------------

    // full text of a file for the editor, plus the mtime that seeds the stale
    // guard. refuses anything too large, binary or not valid utf-8.
    public static function fileText(string $req): array
    {
        $real = self::safePath($req, 'file');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];

        $size = (int)@filesize($real);
        if ($size > self::EDIT_MAX_BYTES) return ['ok' => false, 'error' => 'file is too large to edit here'];

        $content = @file_get_contents($real);
        if ($content === false) return ['ok' => false, 'error' => 'cannot read file'];
        if (strpos($content, "\0") !== false) return ['ok' => false, 'error' => 'not a text file'];
        if (function_exists('mb_check_encoding') && !mb_check_encoding($content, 'UTF-8')) {
            return ['ok' => false, 'error' => 'not valid UTF-8 text'];
        }

        return ['ok' => true, 'content' => $content, 'mtime' => (int)@filemtime($real), 'size' => $size];
    }

    // save edited text back to a file. the write goes to a temp file in the same
    // directory then renames over the target, so a reader never sees a half file.
    // owner, group and mode are carried over. the stale guard refuses a save when
    // the file changed since it was opened, unless the client forces it.
    private static function opSave(): array
    {
        $path    = (string)($_POST['path'] ?? '');
        $content = (string)($_POST['content'] ?? '');
        $baseMt  = isset($_POST['mtime']) ? (int)$_POST['mtime'] : 0;
        $force   = !empty($_POST['force']);

        $real = self::safePath($path, 'file');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];
        if (strlen($content) > self::EDIT_MAX_BYTES) return ['ok' => false, 'error' => 'content too large'];

        $st = @stat($real);
        if ($st === false) return ['ok' => false, 'error' => 'file not found'];

        if (!$force && $baseMt && (int)$st['mtime'] !== $baseMt) {
            return ['ok' => false, 'stale' => true, 'error' => 'the file changed on disk since you opened it'];
        }

        $tmp = dirname($real) . '/.fvsave.' . bin2hex(random_bytes(6));
        if (@file_put_contents($tmp, $content) === false) { @unlink($tmp); return ['ok' => false, 'error' => 'could not write']; }

        @chown($tmp, $st['uid']);
        @chgrp($tmp, $st['gid']);
        @chmod($tmp, $st['mode'] & 07777);

        if (!@rename($tmp, $real)) { @unlink($tmp); return ['ok' => false, 'error' => 'could not save']; }

        clearstatcache(true, $real);
        self::audit('save', ['path' => $real, 'bytes' => strlen($content)]);
        return ['ok' => true, 'mtime' => (int)@filemtime($real), 'size' => strlen($content)];
    }

    // ---- owner and permission (phase 3) ---------------------------------------

    // change mode on a file or folder, optionally through a directory tree. the
    // recursive walk applies the same mode to every entry, like chmod -R, and
    // skips symlinks so a link target outside the tree is never touched.
    private static function opChmod(): array
    {
        $path = (string)($_POST['path'] ?? '');
        $modeRaw = (string)($_POST['mode'] ?? '');
        $recursive = !empty($_POST['recursive']);

        $real = self::safePath($path, '');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];
        if (self::isRootPath($real)) return ['ok' => false, 'error' => 'cannot change a root'];

        $mode = self::parseMode($modeRaw);
        if ($mode === null) return ['ok' => false, 'error' => 'invalid mode'];

        @set_time_limit(0);
        $ok = ($recursive && is_dir($real)) ? self::chmodTree($real, $mode) : @chmod($real, $mode);
        if (!$ok) return ['ok' => false, 'error' => 'chmod failed or incomplete'];

        clearstatcache(true, $real);
        self::audit('chmod', ['path' => $real, 'mode' => sprintf('%04o', $mode), 'recursive' => $recursive ? 1 : 0]);
        return ['ok' => true, 'path' => $real, 'mode' => sprintf('%04o', $mode), 'perms' => self::permString((int)@fileperms($real))];
    }

    // accept an octal string like "644", "0644" or "0755"; null if it is not one
    private static function parseMode(string $s): ?int
    {
        $s = trim($s);
        if (!preg_match('/^0?[0-7]{3,4}$/', $s)) return null;
        return octdec($s) & 07777;
    }

    // children first, then self, so a directory keeps its bits while we descend
    private static function chmodTree(string $path, int $mode): bool
    {
        if (is_link($path)) return true;
        $ok = true;
        if (is_dir($path)) {
            foreach (scandir($path) ?: [] as $e) {
                if ($e === '.' || $e === '..') continue;
                $ok = self::chmodTree($path . DIRECTORY_SEPARATOR . $e, $mode) && $ok;
            }
        }
        return @chmod($path, $mode) && $ok;
    }

    // change owner and/or group. an empty field means leave that part as is. a
    // recursive run walks a directory tree; symlinks are retargeted with lchown,
    // never the file they point to.
    private static function opChown(): array
    {
        $path = (string)($_POST['path'] ?? '');
        $userRaw  = trim((string)($_POST['user'] ?? ''));
        $groupRaw = trim((string)($_POST['group'] ?? ''));
        $recursive = !empty($_POST['recursive']);

        $real = self::safePath($path, '');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];
        if (self::isRootPath($real)) return ['ok' => false, 'error' => 'cannot change a root'];

        $uid = $userRaw  === '' ? -1 : self::resolveUid($userRaw);
        $gid = $groupRaw === '' ? -1 : self::resolveGid($groupRaw);
        if ($uid === null) return ['ok' => false, 'error' => 'unknown user'];
        if ($gid === null) return ['ok' => false, 'error' => 'unknown group'];
        if ($uid === -1 && $gid === -1) return ['ok' => false, 'error' => 'nothing to change'];

        @set_time_limit(0);
        $ok = ($recursive && is_dir($real)) ? self::chownTree($real, $uid, $gid) : self::chownOne($real, $uid, $gid);
        if (!$ok) return ['ok' => false, 'error' => 'chown failed or incomplete'];

        clearstatcache(true, $real);
        $st = @stat($real);
        self::audit('chown', ['path' => $real, 'uid' => $uid, 'gid' => $gid, 'recursive' => $recursive ? 1 : 0]);
        return [
            'ok'    => true,
            'path'  => $real,
            'owner' => $st ? self::uidName((int)$st['uid']) : '',
            'group' => $st ? self::gidName((int)$st['gid']) : '',
        ];
    }

    // a digit string is taken as a numeric id; a name is resolved via posix.
    // returns the id, or null when the name is unknown.
    private static function resolveUid(string $s): ?int
    {
        if (ctype_digit($s)) return (int)$s;
        if (function_exists('posix_getpwnam')) { $p = @posix_getpwnam($s); if ($p && isset($p['uid'])) return (int)$p['uid']; }
        return null;
    }
    private static function resolveGid(string $s): ?int
    {
        if (ctype_digit($s)) return (int)$s;
        if (function_exists('posix_getgrnam')) { $g = @posix_getgrnam($s); if ($g && isset($g['gid'])) return (int)$g['gid']; }
        return null;
    }

    // owner/group on one entry, -1 leaves that part. a symlink is changed with
    // lchown/lchgrp so the link itself moves, not its target.
    private static function chownOne(string $path, int $uid, int $gid): bool
    {
        $link = is_link($path);
        $ok = true;
        if ($uid !== -1) $ok = ($link ? @lchown($path, $uid) : @chown($path, $uid)) && $ok;
        if ($gid !== -1) $ok = ($link ? @lchgrp($path, $gid) : @chgrp($path, $gid)) && $ok;
        return $ok;
    }
    private static function chownTree(string $path, int $uid, int $gid): bool
    {
        $ok = self::chownOne($path, $uid, $gid);
        if (!is_link($path) && is_dir($path)) {
            foreach (scandir($path) ?: [] as $e) {
                if ($e === '.' || $e === '..') continue;
                $ok = self::chownTree($path . DIRECTORY_SEPARATOR . $e, $uid, $gid) && $ok;
            }
        }
        return $ok;
    }

    // ---- copy / move (phase 4) ------------------------------------------------

    // validate the selection and the destination, then hand a copy or move to the
    // background worker. a cross-mountpoint case asks the client to confirm first.
    private static function opCopyMove(string $op): array
    {
        $list      = json_decode((string)($_POST['sources'] ?? ''), true);
        $destReq   = (string)($_POST['dest'] ?? '');
        $conflict  = (string)($_POST['conflict'] ?? 'rename');
        $confirmed = !empty($_POST['confirm']);

        if (!is_array($list) || !$list) return ['ok' => false, 'error' => 'no items'];
        if (!in_array($conflict, ['rename', 'overwrite', 'skip'], true)) $conflict = 'rename';

        $dest = self::safePath($destReq, 'dir');
        if ($dest === null) return ['ok' => false, 'error' => 'destination not allowed'];

        $sources = [];
        foreach ($list as $p) {
            $real = self::safePath((string)$p, '');
            if ($real === null) return ['ok' => false, 'error' => 'a source path is not allowed'];
            if (self::isRootPath($real)) return ['ok' => false, 'error' => 'cannot ' . $op . ' a root'];
            if ($real === $dest)        return ['ok' => false, 'error' => 'source and destination are the same'];
            // destination must not sit inside a source folder, or we would recurse into ourselves
            if (is_dir($real) && strpos($dest . '/', rtrim($real, '/') . '/') === 0) {
                return ['ok' => false, 'error' => 'cannot ' . $op . ' a folder into itself'];
            }
            $sources[] = $real;
        }

        $warn = self::crossMountWarn($sources, $dest, $op);
        if ($warn !== null && !$confirmed) return ['ok' => false, 'warn' => true, 'message' => $warn];

        $id = self::jobNewId();
        if (!self::jobSpawn($id, ['op' => $op, 'sources' => $sources, 'dest' => $dest, 'conflict' => $conflict])) {
            return ['ok' => false, 'error' => 'could not start the job'];
        }
        self::audit($op, ['dest' => $dest, 'count' => count($sources), 'conflict' => $conflict]);
        return ['ok' => true, 'job' => $id];
    }

    // the unraid shfs footgun: moving or copying between a user share (/mnt/user*)
    // and a physical disk or pool can lose data. also flag any move that crosses
    // filesystems, since it becomes a copy then a delete. returns a message or null.
    private static function crossMountWarn(array $sources, string $dest, string $op): ?string
    {
        $destMount = self::mountRoot($dest);
        $destDev   = @stat($dest)['dev'] ?? -1;
        $userMix = false; $crossFs = false;
        foreach ($sources as $s) {
            if (self::isUserShare(self::mountRoot($s)) xor self::isUserShare($destMount)) $userMix = true;
            if ((@stat($s)['dev'] ?? -2) !== $destDev) $crossFs = true;
        }
        if ($userMix) {
            return 'This crosses the user share and a physical disk or pool. On Unraid that can corrupt or lose data. Continue only if you are sure.';
        }
        if ($op === 'move' && $crossFs) {
            return 'The destination is on a different filesystem, so this move copies everything and then deletes the originals. It may take a while.';
        }
        return null;
    }

    private static function mountRoot(string $path): string
    {
        return preg_match('#^(/mnt/[^/]+)#', $path, $m) ? $m[1] : $path;
    }
    private static function isUserShare(string $mount): bool
    {
        return (bool)preg_match('#^/mnt/user[0-9]*$#', $mount);
    }

    // raise the cancel flag the worker checks between files and between chunks
    private static function opJobCancel(): array
    {
        $dir = self::jobDir((string)($_POST['id'] ?? ''));
        if ($dir === null) return ['ok' => false, 'error' => 'no such job'];
        @file_put_contents($dir . '/cancel', '1');
        return ['ok' => true];
    }

    // ---- upload (phase 5) -----------------------------------------------------

    // one chunk of a chunked upload. metadata rides on the query (the body is the
    // raw chunk), so reads stay out of $_POST. chunks are appended to a hidden
    // staging file inside the destination folder, so the final step is a same-fs
    // rename, not a second full copy. the last chunk verifies the size and places
    // the file, inheriting the folder owner, group and mode like a new file.
    private static function opUpload(): array
    {
        $meta = [
            'uid'      => (string)($_POST['uid'] ?? ''),
            'name'     => (string)($_POST['name'] ?? ''),
            'dest'     => (string)($_POST['dest'] ?? ''),
            'subpath'  => (string)($_POST['subpath'] ?? ''),
            'offset'   => (int)($_POST['offset'] ?? -1),
            'total'    => (int)($_POST['total'] ?? -1),
            'last'     => !empty($_POST['last']),
            'conflict' => (string)($_POST['conflict'] ?? 'rename'),
        ];

        // the chunk rides base64 in a normal form field, the same plain post the
        // rest of the webgui uses (proven path on unraid); decode it here
        $b64   = (string)($_POST['data'] ?? '');
        $bytes = $b64 === '' ? '' : base64_decode($b64, true);
        if ($bytes === false) return ['ok' => false, 'error' => 'bad chunk encoding'];

        return self::uploadReceive($meta, (string)$bytes);
    }

    private static function uploadReceive(array $m, string $bytes): array
    {
        $uid = (string)$m['uid'];
        if (!preg_match('/^[a-z0-9]{8,32}$/', $uid)) return ['ok' => false, 'error' => 'bad upload id'];

        $dir = self::safePath((string)$m['dest'], 'dir');
        if ($dir === null) return ['ok' => false, 'error' => 'destination not allowed'];

        $leaf = self::safeName((string)$m['name']);
        if ($leaf === null) return ['ok' => false, 'error' => 'invalid file name'];

        $offset = (int)$m['offset'];
        $total  = (int)$m['total'];
        if ($offset < 0 || $total < 0) return ['ok' => false, 'error' => 'bad chunk'];

        // folder uploads carry a relative subdir under the destination. validate each
        // segment, create the missing levels on the first chunk (inheriting the
        // destination owner), then confine with realpath so nothing climbs out
        $sub = (string)($m['subpath'] ?? '');
        if ($sub !== '') {
            $segs = self::safeSubSegments($sub);
            if ($segs === null) return ['ok' => false, 'error' => 'bad folder path'];
            if ($offset === 0) {
                $bs = @stat($dir);
                $cur = $dir;
                foreach ($segs as $sn) {
                    $cur .= '/' . $sn;
                    if (!is_dir($cur)) {
                        @mkdir($cur);
                        if (!is_dir($cur)) return ['ok' => false, 'error' => 'cannot create folder'];
                        if ($bs !== false) { @chown($cur, $bs['uid']); @chgrp($cur, $bs['gid']); @chmod($cur, $bs['mode'] & 0777); }
                    }
                }
                $tdir = $cur;
            } else {
                $tdir = $dir . '/' . implode('/', $segs);
            }
            $rb = realpath($dir); $rt = realpath($tdir);
            if ($rb === false || $rt === false || strpos($rt . '/', $rb . '/') !== 0) {
                return ['ok' => false, 'error' => 'destination not allowed'];
            }
            $dir = $tdir;
        }

        $part = $dir . '/.fvupload-' . $uid . '.part';

        // the chunk must land exactly at the current staged size, in order
        clearstatcache(true, $part);
        $have = ($offset === 0) ? 0 : (int)@filesize($part);
        if ($offset !== $have)               { @unlink($part); return ['ok' => false, 'error' => 'chunk out of order']; }
        $newSize = $have + strlen($bytes);
        if ($newSize > $total)               { @unlink($part); return ['ok' => false, 'error' => 'upload larger than declared']; }

        $fh = @fopen($part, $offset === 0 ? 'wb' : 'ab');
        if ($fh === false) return ['ok' => false, 'error' => 'cannot stage upload'];
        $w = fwrite($fh, $bytes);
        fclose($fh);
        if ($w === false) { @unlink($part); return ['ok' => false, 'error' => 'write failed']; }

        if (!$m['last']) return ['ok' => true, 'received' => $newSize];

        if ($newSize !== $total) { @unlink($part); return ['ok' => false, 'error' => 'size mismatch']; }

        $conflict = in_array($m['conflict'], ['rename', 'overwrite', 'skip'], true) ? (string)$m['conflict'] : 'rename';
        $target = $dir . '/' . $leaf;
        if (file_exists($target) || is_link($target)) {
            if ($conflict === 'skip')   { @unlink($part); return ['ok' => true, 'name' => $leaf, 'skipped' => true]; }
            if ($conflict === 'rename') { $target = self::freeNamePath($dir, $leaf); }
            // overwrite: keep $target, the rename below replaces the old file
        }
        if (!@rename($part, $target)) {
            if (!@copy($part, $target)) { @unlink($part); return ['ok' => false, 'error' => 'could not save file']; }
            @unlink($part);
        }
        self::inheritParent($target, $dir, false);
        self::audit('upload', ['path' => $target, 'bytes' => $total]);
        return ['ok' => true, 'name' => basename($target), 'done' => true];
    }

    // split a folder upload's relative subpath into validated segments, or null if
    // any segment is unsafe (".." or a name safeName rejects). keeps traversal out
    private static function safeSubSegments(string $sub): ?array
    {
        $out = [];
        foreach (preg_split('#[\\\\/]+#', $sub) as $seg) {
            if ($seg === '' || $seg === '.') continue;
            if ($seg === '..') return null;
            $sn = self::safeName($seg);
            if ($sn === null) return null;
            $out[] = $sn;
        }
        return $out;
    }

    // first free "name (n).ext" in a folder, so an upload never clobbers a sibling
    private static function freeNamePath(string $dir, string $base): string
    {
        $dot  = strrpos($base, '.');
        $name = ($dot !== false && $dot > 0) ? substr($base, 0, $dot) : $base;
        $ext  = ($dot !== false && $dot > 0) ? substr($base, $dot)    : '';
        for ($i = 1; $i < 10000; $i++) {
            $cand = $dir . '/' . $name . ' (' . $i . ')' . $ext;
            if (!file_exists($cand) && !is_link($cand)) return $cand;
        }
        return $dir . '/' . $name . ' (' . uniqid() . ')' . $ext;
    }

    // drop the staging file when the user cancels mid-upload
    private static function opUploadCancel(): array
    {
        $uid = (string)($_POST['uid'] ?? $_GET['uid'] ?? '');
        $dir = self::safePath((string)($_POST['dest'] ?? $_GET['dest'] ?? ''), 'dir');
        if ($dir === null || !preg_match('/^[a-z0-9]{8,32}$/', $uid)) return ['ok' => false, 'error' => 'bad request'];
        @unlink($dir . '/.fvupload-' . $uid . '.part');
        return ['ok' => true];
    }

    // ---- request entry point -------------------------------------------------

    public function run(): void
    {
        self::$obBase = ob_get_level();
        ob_start();                       // trap any stray warning/notice; respond drops it
        self::$obOn = true;
        self::$responded = false;
        register_shutdown_function([self::class, 'shutdownGuard']);

        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-cache, no-store, must-revalidate');
        header('X-Content-Type-Options: nosniff');

        if (!self::validateCsrf()) {
            self::respond(['ok' => false, 'error' => 'bad token'], 403);
            return;
        }

        // action rides on the query (reads, and the write urls the js builds) or
        // in the post body
        $action = (string)($_GET['action'] ?? $_POST['action'] ?? 'list');

        try {
            if (self::isWriteAction($action)) { $this->runWrite($action); return; }

            switch ($action) {
                case 'list':       self::respond(self::listDir((string)($_GET['path'] ?? '')));     return;
                case 'meta':       self::respond(self::meta((string)($_GET['path'] ?? '')));        return;
                case 'preview':    self::respond(self::preview((string)($_GET['path'] ?? '')));     return;
                case 'filetext':   self::respond(self::fileText((string)($_GET['path'] ?? '')));    return;
                case 'attrs':      self::respond(self::attrs((string)($_GET['path'] ?? '')));       return;
                case 'archive':    self::respond(self::archiveList((string)($_GET['path'] ?? '')));  return;
                case 'recycle_list': self::respond(self::recycleList());                            return;
                case 'db_info':    self::respond(self::dbInfo((string)($_GET['path'] ?? '')));    return;
                case 'db_rows':    self::respond(self::dbRows((string)($_GET['path'] ?? '')));    return;
                case 'job_status': $this->jobStatusAction((string)($_GET['id'] ?? ''));             return;
                default:
                    self::respond(['ok' => false, 'error' => 'unknown action'], 400);
            }
        } catch (\Throwable $e) {
            error_log('[filesviewer] ' . $e::class . ': ' . $e->getMessage()
                . ' @ ' . $e->getFile() . ':' . $e->getLine());
            self::respond(['ok' => false, 'error' => 'internal error'], 500);
        }
    }

    // write dispatch. the gate (POST, the csrf check above, path confinement in
    // the helpers) sits here; each case runs its own checks. create, rename and
    // delete arrive next phase, the rest in theirs.
    private function runWrite(string $action): void
    {
        if (!self::requirePost()) { self::respond(['ok' => false, 'error' => 'POST required'], 405); return; }

        switch ($action) {
            case 'create': self::respond(self::opCreate()); return;
            case 'rename': self::respond(self::opRename()); return;
            case 'delete': self::respond(self::opDelete()); return;
            case 'recycle_restore': self::respond(self::recycleRestore()); return;
            case 'recycle_purge':   self::respond(self::recyclePurge());   return;
            case 'space_start':     self::respond(self::opSpaceStart());   return;
            case 'save':   self::respond(self::opSave());   return;
            case 'chmod':  self::respond(self::opChmod());  return;
            case 'chown':  self::respond(self::opChown());  return;
            case 'copy':   self::respond(self::opCopyMove('copy')); return;
            case 'move':   self::respond(self::opCopyMove('move')); return;
            case 'job_cancel': self::respond(self::opJobCancel()); return;
            case 'upload':     self::respond(self::opUpload()); return;
            case 'upload_cancel': self::respond(self::opUploadCancel()); return;

            default:
                self::respond(['ok' => false, 'error' => 'unknown action'], 400);
        }
    }
}

// included by the pages to define the class; run only when called directly as the endpoint
if (basename((string)($_SERVER['SCRIPT_FILENAME'] ?? '')) === 'filesviewer_api.php') {
    (new FilesViewerEndpoint())->run();
}
