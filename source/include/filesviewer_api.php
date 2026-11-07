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

    private const LIST_MAX = 5000;

    private static array $iniCache = [];

    private static function cachedIniRead(string $path, bool $sections = false): array
    {
        $key = $path . ($sections ? '|s' : '|f');
        if (array_key_exists($key, self::$iniCache)) return self::$iniCache[$key];
        if (!is_file($path)) return self::$iniCache[$key] = [];
        $data = @parse_ini_file($path, $sections);
        return self::$iniCache[$key] = (is_array($data) ? $data : []);
    }

    public static function validateCsrf(): bool
    {
        $expected = '';
        $var = @parse_ini_file(self::VAR_INI);
        if (is_array($var) && !empty($var['csrf_token'])) {
            $expected = (string)$var['csrf_token'];
        } elseif (isset($GLOBALS['var']) && is_array($GLOBALS['var']) && !empty($GLOBALS['var']['csrf_token'])) {
            $expected = (string)$GLOBALS['var']['csrf_token'];
        }

        if ($expected === '') return false;

        if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
            return function_exists('csrf_terminate');
        }

        $sent = isset($_SERVER['HTTP_X_CSRF_TOKEN']) ? (string)$_SERVER['HTTP_X_CSRF_TOKEN'] : '';
        if ($sent === '') return false;
        return hash_equals($expected, $sent);
    }

    private const TOK_DIR = '/tmp/filesviewer/tokens';
    private const TOK_TTL = 43200;

    public static function generateNonce(): string
    {
        $tok = bin2hex(random_bytes(16));
        if (!is_dir(self::TOK_DIR) && !@mkdir(self::TOK_DIR, 0700, true)) return '';

        self::nonceTidy();
        $f = self::TOK_DIR . '/' . $tok;
        if (@file_put_contents($f, '') === false) return '';
        @chmod($f, 0600);
        return $tok;
    }

    public static function validateNonce(): bool
    {
        $tok = (string)($_GET['_fvt'] ?? $_POST['_fvt'] ?? '');
        if ($tok === '' || !preg_match('/^[a-f0-9]{32}$/', $tok)) return false;

        $f = self::TOK_DIR . '/' . $tok;
        $m = @filemtime($f);
        if ($m === false) return false;
        if ($m < time() - self::TOK_TTL) { @unlink($f); return false; }
        return true;
    }

    private static function nonceTidy(): void
    {
        $cut = time() - self::TOK_TTL;
        foreach ((array)@glob(self::TOK_DIR . '/*') as $f) {
            $m = @filemtime($f);
            if ($m !== false && $m < $cut) @unlink($f);
        }
    }

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
            'btn_colors'    => (($cfg['FV_BTN_COLORS'] ?? '1') === '1'),
            'edit_default'  => (($cfg['FV_EDIT_DEFAULT'] ?? '0') === '1'),
            'notify'        => (($cfg['FV_NOTIFY'] ?? '1') === '1'),
            'space'         => (($cfg['FV_SPACE'] ?? '0') === '1'),
            'img_max_mb'    => max(1, min(500, (int)($cfg['FV_IMG_MAX_MB'] ?? 50))),
            'archive_max'   => max(50, min(20000, (int)($cfg['FV_ARCHIVE_MAX'] ?? 1000))),
            'autoplay'      => (($cfg['FV_AUTOPLAY'] ?? '0') === '1'),
            'remember'      => (($cfg['FV_REMEMBER'] ?? '1') === '1'),
            'recycle'       => (($cfg['FV_RECYCLE'] ?? '0') === '1'),
            'recycle_days'  => in_array((string)($cfg['FV_RECYCLE_DAYS'] ?? '30'), ['30', '60', 'never'], true) ? (string)($cfg['FV_RECYCLE_DAYS'] ?? '30') : '30',
            'perms_format'  => in_array(strtolower((string)($cfg['FV_PERMS_FORMAT'] ?? 'octal')), ['octal', 'symbolic'], true) ? strtolower((string)($cfg['FV_PERMS_FORMAT'] ?? 'octal')) : 'octal',
        ];
    }

    public static function allowedRoots(): array
    {
        $real = realpath('/mnt');
        return ($real !== false && is_dir($real)) ? [$real] : [];
    }

    public static function safePath(string $req, string $mustBe = ''): ?string
    {
        if ($req === '' || strpos($req, "\0") !== false) return null;

        $real = realpath($req);
        if ($real === false) return null;

        $inside = false;
        foreach (self::allowedRoots() as $root) {
            if ($real === $root || strpos($real, $root . DIRECTORY_SEPARATOR) === 0) {
                $inside = true;
                break;
            }
        }
        if (!$inside || self::inBin($real)) return null;

        if ($mustBe === 'dir'  && !is_dir($real))  return null;
        if ($mustBe === 'file' && !is_file($real)) return null;

        return $real;
    }

    public static function inBin(string $real): bool
    {
        return basename($real) === self::BIN_DIR || strpos($real . '/', '/' . self::BIN_DIR . '/') !== false;
    }

    private static function rootOf(string $real): ?string
    {
        foreach (self::allowedRoots() as $root) {
            if ($real === $root || strpos($real, $root . DIRECTORY_SEPARATOR) === 0) return $root;
        }
        return null;
    }

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
        if (in_array(self::category($ext), ['code', 'md'], true)) return 'text/plain';
        return 'application/octet-stream';
    }

    public static function listDir(string $req): array
    {
        $cfg   = self::config();
        $roots = $cfg['roots'];

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
            if ($name === self::BIN_DIR) continue;
            if (!$showHidden && $name[0] === '.') continue;
            if (++$seen > self::LIST_MAX) break;

            $full  = $real . DIRECTORY_SEPARATOR . $name;
            $st    = @stat($full);
            $isDir = ($st !== false) && (($st['mode'] & 0170000) === 0040000);
            $isLnk = @is_link($full);
            $ext   = $isDir ? '' : self::effectiveExt($name);

            $entries[] = [
                'name'     => $name,
                'path'     => $full,
                'is_dir'   => $isDir,
                'ext'      => $ext,
                'category' => $isDir ? 'dir' : self::category($ext),
                'size'     => ($isDir || $st === false) ? 0 : (int)$st['size'],
                'mtime'    => $st !== false ? (int)$st['mtime'] : 0,
                'owner'    => $st !== false ? self::uidName((int)$st['uid']) : '',
                'group'    => $st !== false ? self::gidName((int)$st['gid']) : '',
                'perms'    => $st !== false ? self::permStringFull((int)$st['mode']) : '',
                'mode'     => $st !== false ? self::octalPerms((int)$st['mode']) : '',
                'link'     => $isLnk,
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
                'group'    => $st !== false ? self::gidName((int)$st['gid']) : '',
                'perms'    => $st !== false ? self::permStringFull((int)$st['mode']) : '',
                'mode'     => $st !== false ? self::octalPerms((int)$st['mode']) : '',
                'link'     => false,
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
            if ($foldersFirst && $a['is_dir'] !== $b['is_dir']) return $a['is_dir'] ? -1 : 1;

            switch ($sort) {
                case 'size':     $c = $a['size']  <=> $b['size'];  break;
                case 'modified': $c = $a['mtime'] <=> $b['mtime']; break;
                default:         $c = strcasecmp($a['name'], $b['name']); break;
            }
            if ($c === 0) $c = strcasecmp($a['name'], $b['name']);
            return $c * $mul;
        });
    }

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

    private static function permString(int $mode): string
    {
        $bits = [0x0100,0x0080,0x0040, 0x0020,0x0010,0x0008, 0x0004,0x0002,0x0001];
        $chr  = ['r','w','x','r','w','x','r','w','x'];
        $s = '';
        foreach ($bits as $i => $bit) $s .= ($mode & $bit) ? $chr[$i] : '-';
        return $s;
    }

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

    private static function octalPerms(int $mode): string
    {
        $m = $mode & 07777;
        return ($m & 07000) ? sprintf('%04o', $m) : sprintf('%o', $m & 0777);
    }

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

    public static function preview(string $req): array
    {
        $real = self::safePath($req, 'file');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];

        $cfg  = self::config();
        $ext  = self::effectiveExt(basename($real));
        $cat  = self::category($ext);
        $size = (int)@filesize($real);

        if ($cat !== 'code' && $cat !== 'md') {
            return ['ok' => true, 'kind' => 'none', 'category' => $cat, 'size' => $size];
        }

        $capBytes = max(64, (int)$cfg['text_cap_kb']) * 1024;
        $fh = @fopen($real, 'rb');
        if ($fh === false) return ['ok' => false, 'error' => 'cannot read file'];
        $content = (string)fread($fh, $capBytes + 1);
        fclose($fh);

        $truncated = strlen($content) > $capBytes;
        if ($truncated) $content = substr($content, 0, $capBytes);

        if (strpos($content, "\0") !== false) {
            return ['ok' => true, 'kind' => 'binary', 'category' => $cat, 'size' => $size];
        }

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

    public static function archiveList(string $req): array
    {
        $real = self::safePath($req, 'file');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];

        $cfg   = self::config();
        $max   = max(50, (int)$cfg['archive_max']);
        $arg   = escapeshellarg($real);

        [$fmt] = self::archiveKind(basename($real));
        $entries = [];
        $truncated = false;

        if ($fmt === 'zip') {
            $z = new \ZipArchive();
            if ($z->open($real, \ZipArchive::RDONLY) !== true) return ['ok' => false, 'error' => 'not a zip archive, or damaged'];
            $n = $z->numFiles;
            for ($i = 0; $i < $n && $i < $max; $i++) {
                $st = $z->statIndex($i);
                if ($st === false) continue;
                $nm = str_replace('\\', '/', (string)$st['name']);
                $entries[] = ['name' => $nm, 'size' => (int)$st['size'], 'is_dir' => (substr($nm, -1) === '/')];
            }
            $truncated = $n > $max;
            $z->close();
        } else {
            switch ($fmt) {
                case 'tar':  $cmd = 'tar -tvf ' . $arg;  break;
                case 'tgz':  $cmd = 'tar -tzvf ' . $arg; break;
                case 'tbz2': $cmd = 'tar -tjvf ' . $arg; break;
                case 'txz':  $cmd = 'tar -tJvf ' . $arg; break;
                default:
                    return ['ok' => true, 'kind' => 'arch_unsupported', 'category' => 'arch', 'size' => (int)@filesize($real)];
            }
            $lines = [];
            @exec('timeout 20 ' . $cmd . ' 2>/dev/null | head -n ' . ($max + 40), $lines);
            foreach ($lines as $ln) {
                if (preg_match('#^([dl\-][rwxsStT\-]{9})\S*\s+\S+\s+(\d+)\s+(?:\d{4}-\d\d-\d\d|\d\d-\d\d-\d{4})\s+\d\d:\d\d\s+(.+)$#', $ln, $m)) {
                    $nm    = $m[3];
                    $isDir = ($m[1][0] === 'd') || (substr($nm, -1) === '/');
                    $arrow = strpos($nm, ' -> ');
                    if ($arrow !== false) $nm = substr($nm, 0, $arrow);
                    $entries[] = ['name' => $nm, 'size' => (int)$m[2], 'is_dir' => $isDir];
                }
                if (count($entries) >= $max) { $truncated = true; break; }
            }
        }

        return [
            'ok'        => true,
            'kind'      => 'archive',
            'category'  => 'arch',
            'count'     => count($entries),
            'truncated' => $truncated,
            'entries'   => $entries,
            'extract'   => self::archiveExtractName($real),
        ];
    }

    public static function archiveKind(string $name): array
    {
        $ends = ['.tar.gz' => 'tgz', '.tgz' => 'tgz', '.tar.bz2' => 'tbz2', '.tbz2' => 'tbz2', '.tbz' => 'tbz2',
                 '.tar.xz' => 'txz', '.txz' => 'txz', '.tar' => 'tar', '.zip' => 'zip',
                 '.gz' => '', '.bz2' => '', '.xz' => '', '.7z' => '', '.rar' => ''];
        $scan = strtolower($name);
        while (strpos($scan, '.') !== false) {
            foreach ($ends as $suffix => $fmt) {
                if (str_ends_with($scan, $suffix)) {
                    return [$fmt, substr($name, 0, strlen($scan) - strlen($suffix))];
                }
            }
            $scan = substr($scan, 0, strrpos($scan, '.'));
        }
        return ['', $name];
    }

    private static function archiveExtractName(string $real): ?array
    {
        [$fmt, $stem] = self::archiveKind(basename($real));
        if ($fmt === '' || self::safeName($stem) === null) return null;
        $dest = dirname($real) . '/' . $stem;
        return ['folder' => $stem, 'taken' => file_exists($dest) || is_link($dest), 'writable' => is_writable(dirname($real))];
    }

    private static function opCompress(): array
    {
        $list = json_decode((string)($_POST['sources'] ?? ''), true);
        $fmt  = (string)($_POST['format'] ?? 'zip');
        $name = self::safeName((string)($_POST['name'] ?? ''));
        if (!is_array($list) || !$list) return ['ok' => false, 'error' => 'no items'];
        if (!in_array($fmt, ['zip', 'tgz'], true)) return ['ok' => false, 'error' => 'bad format'];
        if ($name === null) return ['ok' => false, 'error' => 'bad archive name'];

        $sources = []; $parent = null;
        foreach ($list as $p) {
            $real = self::safePath((string)$p, '');
            if ($real === null) return ['ok' => false, 'error' => 'a source path is not allowed'];
            if (self::isRootPath($real)) return ['ok' => false, 'error' => 'cannot compress a root'];
            $dir = dirname($real);
            if ($parent === null) $parent = $dir;
            elseif ($dir !== $parent) return ['ok' => false, 'error' => 'items must sit in the same folder'];
            $sources[] = $real;
        }
        if (!is_writable($parent)) return ['ok' => false, 'error' => 'the folder is not writable'];

        $ext  = $fmt === 'zip' ? '.zip' : '.tar.gz';
        $name = preg_replace('/\.(zip|tar\.gz|tgz)$/i', '', $name);
        if ($name === '' || $name === '.' || $name === '..') return ['ok' => false, 'error' => 'bad archive name'];
        $dest = $parent . '/' . $name . $ext;
        for ($i = 1; (file_exists($dest) || is_link($dest)) && $i < 10000; $i++) $dest = $parent . '/' . $name . ' (' . $i . ')' . $ext;

        $id = self::jobNewId();
        if (!self::jobSpawn($id, ['op' => 'compress', 'sources' => $sources, 'dest' => $dest, 'format' => $fmt])) {
            return ['ok' => false, 'error' => 'could not start the job'];
        }
        self::audit('compress', ['dest' => $dest, 'count' => count($sources), 'job' => $id]);
        return ['ok' => true, 'job' => $id, 'name' => basename($dest)];
    }

    public static function zipSources(string $json): array
    {
        $list = json_decode($json, true);
        if (!is_array($list) || !$list) return ['ok' => false, 'error' => 'no items'];
        if (count($list) > self::LIST_MAX) return ['ok' => false, 'error' => 'too many items'];

        $items = []; $names = [];
        foreach ($list as $p) {
            $real = self::safePath((string)$p, '');
            if ($real === null) return ['ok' => false, 'error' => 'a path is not allowed'];
            if (self::isRootPath($real)) return ['ok' => false, 'error' => 'cannot pack a root'];
            $name = basename($real);
            for ($i = 2; isset($names[$name]); $i++) $name = basename($real) . ' (' . $i . ')';
            $names[$name] = true;
            $items[] = ['path' => $real, 'name' => $name];
        }
        return ['ok' => true, 'items' => $items];
    }

    public static function zipName(string $req, array $items): string
    {
        $name = self::safeName($req) ?? '';
        $name = preg_replace('/\.zip$/i', '', $name);
        if ($name === '' || $name === '.' || $name === '..') $name = count($items) === 1 ? (string)$items[0]['name'] : 'files';
        return $name . '.zip';
    }

    private static function zipInfo(): array
    {
        if (!self::validateNonce()) return ['ok' => false, 'error' => 'this page has been open too long, reload it'];
        $src = self::zipSources((string)($_POST['paths'] ?? ''));
        if (!$src['ok']) return $src;

        $files = 0; $bytes = 0; $seen = 0; $capped = false;
        $stop = microtime(true) + 2.0;
        $walk = function (string $path) use (&$walk, &$files, &$bytes, &$seen, &$capped, $stop): void {
            if ($capped || is_link($path)) return;
            if (++$seen > 20000 || microtime(true) > $stop) { $capped = true; return; }
            if (is_file($path)) { $files++; $bytes += (int)@filesize($path); return; }
            if (!is_dir($path)) return;
            foreach ((array)@scandir($path) as $e) {
                if ($e === '.' || $e === '..') continue;
                $walk($path . '/' . $e);
                if ($capped) return;
            }
        };
        foreach ($src['items'] as $it) $walk($it['path']);
        return ['ok' => true, 'files' => $files, 'bytes' => $bytes, 'capped' => $capped];
    }

    private static function opExtract(): array
    {
        $real = self::safePath((string)($_POST['path'] ?? ''), 'file');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];

        [$fmt, $stem] = self::archiveKind(basename($real));
        if ($fmt === '') return ['ok' => false, 'error' => 'this archive type cannot be extracted here'];
        if (self::safeName($stem) === null) return ['ok' => false, 'error' => 'bad folder name'];

        $parent = dirname($real);
        if (!is_writable($parent)) return ['ok' => false, 'error' => 'the folder is not writable'];

        foreach ((array)@glob($parent . '/.fvextract-*', GLOB_ONLYDIR) as $old) {
            $mt = @filemtime($old);
            if ($mt !== false && $mt < time() - 86400 && self::removeTree($old)) self::audit('extract_cleanup', ['path' => $old]);
        }

        $id   = self::jobNewId();
        $dest = $parent . '/.fvextract-' . $id;
        if (!self::jobSpawn($id, ['op' => 'extract', 'archive' => $real, 'dest' => $dest, 'name' => $stem, 'format' => $fmt])) {
            return ['ok' => false, 'error' => 'could not start the job'];
        }
        self::audit('extract', ['archive' => $real, 'dest' => $parent . '/' . $stem, 'job' => $id]);
        return ['ok' => true, 'job' => $id];
    }

    private const WRITE_ACTIONS = ['create','rename','delete','save','move','copy','chmod','chown','upload','upload_cancel','job_cancel','recycle_restore','recycle_purge','space_start','fav_toggle','extract','compress','zip_info','search_start','newperms','checksum_start'];
    private const AUDIT_LOG     = '/var/log/filesviewer.log';
    private const EDIT_MAX_BYTES = 2097152;

    private static int  $obBase = 0;
    private static bool $obOn   = false;
    private static bool $responded = false;

    public static function isWriteAction(string $action): bool
    {
        return in_array($action, self::WRITE_ACTIONS, true);
    }

    private static function requirePost(): bool
    {
        return ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST';
    }

    public static function safeName(string $name): ?string
    {
        $name = trim($name);
        if ($name === '' || $name === '.' || $name === '..') return null;
        if (strlen($name) > 255) return null;
        if (strpbrk($name, "/\\") !== false) return null;
        for ($i = 0, $n = strlen($name); $i < $n; $i++) {
            if (ord($name[$i]) < 0x20) return null;
        }
        return $name;
    }

    public static function safeNewPath(string $parentReq, string $name): ?array
    {
        $dir = self::safePath($parentReq, 'dir');
        if ($dir === null) return null;
        $leaf = self::safeName($name);
        if ($leaf === null) return null;
        return ['dir' => $dir, 'name' => $leaf, 'path' => $dir . DIRECTORY_SEPARATOR . $leaf];
    }

    public static function isRootPath(string $real): bool
    {
        foreach (self::allowedRoots() as $root) {
            if ($real === $root) return true;
        }
        return false;
    }

    public static function isMountPoint(string $real): bool
    {
        $here = @stat($real);
        $up   = @stat(dirname($real));
        return $here !== false && $up !== false && $here['dev'] !== $up['dev'];
    }

    public static function isProtectedPath(string $real): bool
    {
        return self::isRootPath($real) || self::isMountPoint($real);
    }

    private static function audit(string $action, array $fields): void
    {
        if ((int)@filesize(self::AUDIT_LOG) > 2097152) @rename(self::AUDIT_LOG, self::AUDIT_LOG . '.1');
        $parts = [date('Y-m-d H:i:s'), $action];
        foreach ($fields as $k => $v) $parts[] = $k . '=' . str_replace(["\n","\r"], ' ', (string)$v);
        @file_put_contents(self::AUDIT_LOG, implode('  ', $parts) . "\n", FILE_APPEND | LOCK_EX);
    }

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

    private static function respond(array $payload, int $code = 200): void
    {
        self::$responded = true;
        if (self::$obOn) {
            while (ob_get_level() > self::$obBase) ob_end_clean();
            self::$obOn = false;
        }
        if (!headers_sent()) {
            if ($code !== 200) http_response_code($code);
            header('Content-Type: application/json; charset=utf-8');
        }
        echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    }

    public static function jobsBaseDir(): string { return '/tmp/filesviewer/jobs'; }

    private static function jobNewId(): string { return bin2hex(random_bytes(8)); }

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

    private static function jobsTidy(): void
    {
        $cut = time() - 86400;
        foreach ((array)@glob(self::jobsBaseDir() . '/*', GLOB_ONLYDIR) as $d) {
            $m = @filemtime($d . '/status.json');
            if ($m === false) $m = (int)@filemtime($d);
            if ($m > 0 && $m < $cut) self::removeTree($d);
        }
    }

    private static function jobSpawn(string $id, array $spec): bool
    {
        self::jobsTidy();
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

    private const FAV_FILE = '/boot/config/plugins/filesviewer/favourites.json';
    private const FAV_MAX  = 20;

    private static function favLoad(): array
    {
        $raw = @file_get_contents(self::FAV_FILE);
        if ($raw === false) return [];
        $d = json_decode($raw, true);
        if (!is_array($d)) return [];

        $out = [];
        foreach ($d as $p) {
            if (!is_string($p) || $p === '') continue;
            if (!in_array($p, $out, true)) $out[] = $p;
        }
        return array_slice($out, 0, self::FAV_MAX);
    }

    private static function favSave(array $paths): bool
    {
        $json = json_encode(array_values($paths), JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        if (@file_get_contents(self::FAV_FILE) === $json) return true;

        $dir = dirname(self::FAV_FILE);
        if (!is_dir($dir) && !@mkdir($dir, 0755, true)) return false;

        $tmp = self::FAV_FILE . '.tmp';
        if (@file_put_contents($tmp, $json) !== strlen($json) || !@rename($tmp, self::FAV_FILE)) {
            @unlink($tmp);
            return false;
        }
        @chmod(self::FAV_FILE, 0644);
        return true;
    }

    private static function favPrune(array $paths, array &$live): array
    {
        $keep = [];
        foreach ($paths as $p) {
            if (@file_exists($p)) { $keep[] = $p; $live[] = $p; continue; }
            if (!@is_dir(dirname($p))) $keep[] = $p;
        }
        return $keep;
    }

    private static function favEntries(): array
    {
        $stored = self::favLoad();
        $live   = [];
        $keep   = self::favPrune($stored, $live);
        if ($keep !== $stored) self::favSave($keep);

        $out = [];
        foreach ($live as $p) {
            if (self::safePath($p) === null) continue;
            $out[] = ['path' => $p, 'name' => basename($p), 'is_dir' => @is_dir($p)];
        }
        return $out;
    }

    private static function favList(): array
    {
        return ['ok' => true, 'entries' => self::favEntries()];
    }

    private static function favToggle(): array
    {
        $real = self::safePath((string)($_POST['path'] ?? ''));
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];

        $paths = self::favLoad();
        $i     = array_search($real, $paths, true);

        if ($i !== false) {
            array_splice($paths, (int)$i, 1);
            $on = false;
        } else {
            if (count($paths) >= self::FAV_MAX) {
                return ['ok' => false, 'error' => 'favourites are full, remove one first'];
            }
            $paths[] = $real;
            $on = true;
        }

        if (!self::favSave($paths)) return ['ok' => false, 'error' => 'could not save favourites'];
        self::audit($on ? 'fav_add' : 'fav_remove', ['path' => $real]);
        return ['ok' => true, 'fav' => $on, 'entries' => self::favEntries()];
    }

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
            $fh = @fopen($t['path'], 'x');
            if ($fh === false) return ['ok' => false, 'error' => 'could not create the file'];
            fclose($fh);
        }

        self::inheritParent($t['path'], $t['dir'], $kind === 'dir');
        self::audit('create', ['kind' => $kind, 'path' => $t['path']]);
        return ['ok' => true, 'path' => $t['path'], 'name' => $t['name']];
    }

    private static function inheritParent(string $path, string $parent, bool $isDir): void
    {
        $st = @stat($parent);
        if ($st === false) return;
        @chown($path, $st['uid']);
        @chgrp($path, $st['gid']);
        $mode = $st['mode'] & 0777;
        if (!$isDir) $mode &= 0666;
        @chmod($path, $mode);
    }

    private static function opRename(): array
    {
        $path = (string)($_POST['path'] ?? '');
        $name = (string)($_POST['name'] ?? '');

        $real = self::safePath($path, '');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];
        if (self::isProtectedPath($real)) return ['ok' => false, 'error' => 'cannot rename a root or a mounted share'];

        $leaf = self::safeName($name);
        if ($leaf === null) return ['ok' => false, 'error' => 'invalid name'];

        $dest = dirname($real) . DIRECTORY_SEPARATOR . $leaf;
        if ($dest === $real) return ['ok' => true, 'path' => $real, 'name' => basename($real)];
        if (file_exists($dest)) return ['ok' => false, 'error' => 'an item with that name already exists'];

        if (!@rename($real, $dest)) return ['ok' => false, 'error' => 'rename failed'];
        self::audit('rename', ['from' => $real, 'to' => $dest]);
        return ['ok' => true, 'path' => $dest, 'name' => $leaf];
    }

    private static function opDelete(): array
    {
        $mode = self::config()['recycle'] ? 'trash' : 'permanent';

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
            if (self::isProtectedPath($real)) return ['ok' => false, 'error' => 'cannot delete a root or a mounted share'];
            $reals[] = $real;
        }

        if ($mode === 'trash' && self::binShareRoot($reals[0]) === null) $mode = 'permanent';
        if ($mode === 'trash') return self::opTrash($reals);

        @set_time_limit(0);
        $failed = [];
        foreach ($reals as $real) {
            if (!self::removeTree($real)) { $failed[] = basename($real); continue; }
            self::audit('delete', ['mode' => 'permanent', 'path' => $real]);
        }
        return ['ok' => count($failed) < count($reals), 'deleted' => count($reals) - count($failed), 'failed' => $failed]
             + ($failed && count($failed) === count($reals) ? ['error' => 'delete failed or incomplete'] : []);
    }

    public static function removeTree(string $path): bool
    {
        if (is_link($path) || !is_dir($path)) return @unlink($path);

        $ok = true;
        foreach (scandir($path) ?: [] as $e) {
            if ($e === '.' || $e === '..') continue;
            $ok = self::removeTree($path . DIRECTORY_SEPARATOR . $e) && $ok;
        }
        return @rmdir($path) && $ok;
    }

    private const DB_EXTS = ['db', 'db3', 'sqlite', 'sqlite3'];

    private static function sqliteEngine(): ?string
    {
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
            error_log('[filesviewer] sqlite open: ' . $e->getMessage());
            $err = 'the file could not be opened as a database';
            return null;
        }
    }

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
            $budget = microtime(true) + 3.0;
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
            error_log('[filesviewer] sqlite read: ' . $e->getMessage());
            return ['ok' => false, 'error' => 'read failed' . ($wal ? ': the database is in wal mode and may be busy' : '')];
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
            [, $ex] = self::sqAll($c, "select 1 from sqlite_master where type in ('table','view') and name = ?", [$table]);
            if (!$ex) return ['ok' => false, 'error' => 'no such table'];
            $q = '"' . str_replace('"', '""', $table) . '"';
            [$cols, $rows] = self::sqAll($c, 'select * from ' . $q . ' limit ' . ($lim + 1) . ' offset ' . $off);
        } catch (Throwable $e) {
            error_log('[filesviewer] sqlite read: ' . $e->getMessage());
            return ['ok' => false, 'error' => 'read failed' . ($wal ? ': the database is in wal mode and may be busy' : '')];
        }

        $more = count($rows) > $lim;
        if ($more) array_pop($rows);
        foreach ($rows as &$r) { foreach ($r as &$v) { $v = self::dbCell($v); } }
        unset($r, $v);

        return ['ok' => true, 'table' => $table, 'columns' => $cols, 'rows' => $rows,
                'offset' => $off, 'limit' => $lim, 'more' => $more];
    }

    private static function dbCell($v)
    {
        if ($v === null || is_int($v) || is_float($v)) return $v;
        $s = (string)$v;
        if ($s !== '' && !preg_match('//u', $s)) return '[blob ' . strlen($s) . ' B]';
        if (strlen($s) > 300) return substr($s, 0, 300) . '...';
        return $s;
    }

    private static function opSpaceStart(): array
    {
        if (!self::config()['space']) return ['ok' => false, 'error' => 'space analysis is off'];

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

    private static function opSearchStart(): array
    {
        $real = self::safePath((string)($_POST['path'] ?? ''), 'dir');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];
        $q = trim((string)($_POST['q'] ?? ''));
        if ($q === '' || strlen($q) > 200 || preg_match('/[\x00-\x1f\x7f\/]/', $q)) return ['ok' => false, 'error' => 'enter something to look for'];

        $id = self::jobNewId();
        if (!self::jobSpawn($id, ['op' => 'search', 'path' => $real, 'q' => $q])) {
            return ['ok' => false, 'error' => 'cannot start the search'];
        }
        return ['ok' => true, 'id' => $id];
    }

    private static function diskInfo(): array
    {
        $out = [];
        foreach (self::cachedIniRead('/var/local/emhttp/disks.ini', true) as $sec => $d) {
            if (!is_array($d)) continue;
            $name = (string)($d['name'] ?? $sec);
            if (!preg_match('/^[A-Za-z0-9_.-]+$/', $name)) continue;
            $out[$name] = [
                'type'     => (string)($d['type'] ?? ''),
                'id'       => (string)($d['id'] ?? ''),
                'device'   => (string)($d['device'] ?? ''),
                'bytes'    => (int)($d['size'] ?? 0) * 1024,
                'fs'       => (string)($d['fsType'] ?? ''),
                'temp'     => is_numeric($d['temp'] ?? '') ? (int)$d['temp'] : null,
                'spundown' => (($d['spundown'] ?? '0') === '1'),
            ];
        }
        return $out;
    }

    private static function diskRoots(array $info): array
    {
        $roots = [];
        foreach ($info as $name => $d) {
            if (!in_array($d['type'], ['Data', 'Cache'], true) || !is_dir('/mnt/' . $name)) continue;
            $roots[] = '/mnt/' . $name;
        }
        if ($roots) return $roots;
        foreach ((array)@glob('/mnt/*', GLOB_ONLYDIR) as $d) {
            if (!in_array(basename($d), ['user', 'user0', 'disks', 'remotes', 'addons', 'rootshare'], true)) $roots[] = $d;
        }
        return $roots;
    }

    private static function diskCard(string $name, array $info, array $roots): array
    {
        $d = $info[$name] ?? null;
        $card = ['disk' => $name, 'id' => '', 'device' => '', 'bytes' => 0, 'fs' => '', 'temp' => null, 'pool' => false, 'members' => []];
        if ($d === null) return $card;
        $card['id'] = $d['id']; $card['device'] = $d['device']; $card['bytes'] = $d['bytes'];
        $card['fs'] = $d['fs']; $card['temp'] = $d['temp']; $card['pool'] = ($d['type'] === 'Cache');
        if ($card['pool']) {
            foreach ($info as $other => $od) {
                if ($other === $name || $od['type'] !== 'Cache' || !preg_match('/^' . preg_quote($name, '/') . '\d+$/', $other)) continue;
                if (in_array('/mnt/' . $other, $roots, true)) continue;
                $card['members'][] = ['id' => $od['id'], 'device' => $od['device'], 'bytes' => $od['bytes']];
            }
        }
        return $card;
    }

    public static function locate(string $req): array
    {
        $real = self::safePath($req, '');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];
        $info  = self::diskInfo();
        $roots = self::diskRoots($info);
        $found = [];

        if (preg_match('#^/mnt/user0?/(.+)$#', $real, $m)) {
            foreach ($roots as $root) {
                $p  = $root . '/' . $m[1];
                $st = @lstat($p);
                if ($st === false) continue;
                $kind = $st['mode'] & 0170000;
                $found[] = ['path' => $p, 'is_dir' => $kind === 0040000, 'link' => $kind === 0120000,
                            'size' => $kind === 0100000 ? (int)$st['size'] : 0, 'mtime' => (int)$st['mtime']] + self::diskCard(basename($root), $info, $roots);
            }
            return ['ok' => true, 'mode' => 'user', 'name' => basename($real), 'is_dir' => is_dir($real), 'checked' => count($roots), 'locations' => $found];
        }

        foreach ($roots as $root) {
            if ($real === $root || strpos($real, $root . '/') !== 0) continue;
            $st = @lstat($real);
            $kind = $st !== false ? ($st['mode'] & 0170000) : 0;
            $found[] = ['path' => $real, 'is_dir' => $kind === 0040000, 'link' => $kind === 0120000,
                        'size' => $kind === 0100000 ? (int)$st['size'] : 0, 'mtime' => $st !== false ? (int)$st['mtime'] : 0] + self::diskCard(basename($root), $info, $roots);
            return ['ok' => true, 'mode' => 'disk', 'name' => basename($real), 'is_dir' => is_dir($real), 'checked' => 1, 'locations' => $found];
        }
        return ['ok' => false, 'error' => 'this path is not on an array disk or a pool'];
    }

    private const BIN_DIR  = '.RecycleBin';
    private const EVENT_RX = '/^\d{8}-\d{6}-[a-z0-9]{6}$/';

    private static function binShareRoot(string $real): ?string
    {
        $parts = array_values(array_filter(explode('/', $real), 'strlen'));
        if (count($parts) < 4 || $parts[0] !== 'mnt') return null;
        return '/mnt/' . $parts[1] . '/' . $parts[2];
    }

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
        @chown($bin, 0); @chgrp($bin, 0); @chmod($bin, 0700);

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
                $home    = (string)($meta['share_root'] ?? '');
                $foreign = ($home !== '' && $home !== dirname($bin)) ? $home : '';

                $row = [
                    'id'         => $e,
                    'event'      => $ed,
                    'share'      => basename(dirname($bin)),
                    'origin'     => dirname($bin),
                    'foreign'    => $foreign,
                    'deleted_at' => (int)($meta['deleted_at'] ?? @filemtime($ed)),
                    'count'      => count($items),
                    'kind'       => count($items) === 1 ? (!empty($items[0]['is_dir']) ? 'dir' : 'file') : 'multi',
                    'names'      => array_slice($names, 0, 3),
                    'size'       => $size,
                    'size_partial' => !$sized,
                ];
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

        $home = (string)($meta['share_root'] ?? '');
        if ($home !== '' && $home !== $shareRoot) {
            return ['ok' => false, 'error' => 'these items were deleted from ' . basename($home) .
                    ', so they cannot be put back from here. Move this bin folder back into that share first.'];
        }

        $basis = @stat($shareRoot);
        $done = 0; $failed = []; $left = [];
        foreach ($items as $it) {
            $rel  = (string)($it['rel'] ?? '');
            $dest = (string)($it['original'] ?? '');
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
                'share_root' => ($meta['share_root'] ?? $shareRoot), 'items' => $left,
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

        if ($mode === 'expired' && $days === 'never') return ['ok' => true, 'purged' => 0];
        $cut = time() - (int)$days * 86400;

        $n = 0; $bad = 0;
        foreach ($bins as $bin) {
            foreach (scandir($bin) ?: [] as $e) {
                if (!preg_match(self::EVENT_RX, $e)) continue;
                $ed = $bin . '/' . $e;
                if (!file_exists($ed) && !is_link($ed)) continue;
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

    private static function binTidy(string $bin): void
    {
        if (!is_dir($bin)) return;
        $rest = array_diff(scandir($bin) ?: [], ['.', '..']);
        if (!$rest) @rmdir($bin);
    }

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

    private static function parseMode(string $s): ?int
    {
        $s = trim($s);
        if (!preg_match('/^0?[0-7]{3,4}$/', $s)) return null;
        return octdec($s) & 07777;
    }

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

    private static function opNewPerms(): array
    {
        $real = self::safePath((string)($_POST['path'] ?? ''), '');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];
        if (self::isRootPath($real)) return ['ok' => false, 'error' => 'cannot change a root'];

        $uid = self::resolveUid('nobody');
        $gid = self::resolveGid('users');
        if ($uid === null || $gid === null) return ['ok' => false, 'error' => 'the nobody user or the users group is missing'];

        @set_time_limit(0);
        $ok = self::newPermsTree($real, $uid, $gid);
        clearstatcache(true, $real);
        self::audit('newperms', ['path' => $real]);
        if (!$ok) return ['ok' => false, 'error' => 'some entries could not be changed'];
        return ['ok' => true, 'path' => $real];
    }

    private static function newPermsTree(string $path, int $uid, int $gid): bool
    {
        if (is_link($path)) return true;
        $ok = self::chownOne($path, $uid, $gid);
        if (is_dir($path)) {
            foreach (scandir($path) ?: [] as $e) {
                if ($e === '.' || $e === '..' || $e === self::BIN_DIR) continue;
                $ok = self::newPermsTree($path . DIRECTORY_SEPARATOR . $e, $uid, $gid) && $ok;
            }
            return @chmod($path, 0777) && $ok;
        }
        return @chmod($path, 0666) && $ok;
    }

    private const HASH_ALGOS = ['sha256', 'sha1', 'md5', 'sha512'];

    private static function opChecksumStart(): array
    {
        $real = self::safePath((string)($_POST['path'] ?? ''), 'file');
        if ($real === null) return ['ok' => false, 'error' => 'path not allowed'];
        $algo = strtolower((string)($_POST['algo'] ?? 'sha256'));
        if (!in_array($algo, self::HASH_ALGOS, true)) return ['ok' => false, 'error' => 'unknown algorithm'];
        if (!is_readable($real)) return ['ok' => false, 'error' => 'cannot read file'];

        $id = self::jobNewId();
        if (!self::jobSpawn($id, ['op' => 'checksum', 'path' => $real, 'algo' => $algo])) {
            return ['ok' => false, 'error' => 'cannot start'];
        }
        return ['ok' => true, 'id' => $id];
    }

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
            if ($op === 'move' && self::isMountPoint($real)) return ['ok' => false, 'error' => 'cannot move a mounted share or disk'];
            if ($real === $dest)        return ['ok' => false, 'error' => 'source and destination are the same'];
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

    private static function opJobCancel(): array
    {
        $dir = self::jobDir((string)($_POST['id'] ?? ''));
        if ($dir === null) return ['ok' => false, 'error' => 'no such job'];
        @file_put_contents($dir . '/cancel', '1');
        return ['ok' => true];
    }

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

        if ($offset === 0) {
            foreach ((array)@glob($dir . '/.fvupload-*.part') as $old) {
                $mt = @filemtime($old);
                if ($mt !== false && $mt < time() - 86400 && @unlink($old)) {
                    self::audit('upload_cleanup', ['path' => $old]);
                }
            }
        }

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
        }
        if (!@rename($part, $target)) {
            if (!@copy($part, $target)) { @unlink($part); return ['ok' => false, 'error' => 'could not save file']; }
            @unlink($part);
        }
        self::inheritParent($target, $dir, false);
        self::audit('upload', ['path' => $target, 'bytes' => $total]);
        return ['ok' => true, 'name' => basename($target), 'done' => true];
    }

    public static function safeSubSegments(string $sub): ?array
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

    public static function freeNamePath(string $dir, string $base): string
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

    private static function opUploadCancel(): array
    {
        $uid = (string)($_POST['uid'] ?? $_GET['uid'] ?? '');
        $dir = self::safePath((string)($_POST['dest'] ?? $_GET['dest'] ?? ''), 'dir');
        if ($dir === null || !preg_match('/^[a-z0-9]{8,32}$/', $uid)) return ['ok' => false, 'error' => 'bad request'];
        @unlink($dir . '/.fvupload-' . $uid . '.part');
        return ['ok' => true];
    }

    public function run(): void
    {
        self::$obBase = ob_get_level();
        ob_start();
        self::$obOn = true;
        self::$responded = false;
        register_shutdown_function([self::class, 'shutdownGuard']);

        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-cache, no-store, must-revalidate');
        header('X-Content-Type-Options: nosniff');

        if (!self::validateCsrf()) {
            self::respond(['ok' => false, 'error' => 'bad or missing token'], 403);
            return;
        }

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
                case 'fav_list':   self::respond(self::favList());                                  return;
                case 'db_info':    self::respond(self::dbInfo((string)($_GET['path'] ?? '')));    return;
                case 'db_rows':    self::respond(self::dbRows((string)($_GET['path'] ?? '')));    return;
                case 'job_status': $this->jobStatusAction((string)($_GET['id'] ?? ''));             return;
                case 'locate':     self::respond(self::locate((string)($_GET['path'] ?? '')));      return;
                default:
                    self::respond(['ok' => false, 'error' => 'unknown action'], 400);
            }
        } catch (\Throwable $e) {
            error_log('[filesviewer] ' . $e::class . ': ' . $e->getMessage()
                . ' @ ' . $e->getFile() . ':' . $e->getLine());
            self::respond(['ok' => false, 'error' => 'internal error'], 500);
        }
    }

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
            case 'fav_toggle':    self::respond(self::favToggle());     return;
            case 'extract':       self::respond(self::opExtract());     return;
            case 'compress':      self::respond(self::opCompress());    return;
            case 'zip_info':      self::respond(self::zipInfo());       return;
            case 'search_start':  self::respond(self::opSearchStart()); return;
            case 'newperms':      self::respond(self::opNewPerms());    return;
            case 'checksum_start': self::respond(self::opChecksumStart()); return;

            default:
                self::respond(['ok' => false, 'error' => 'unknown action'], 400);
        }
    }
}

if (basename((string)($_SERVER['SCRIPT_FILENAME'] ?? '')) === 'filesviewer_api.php') {
    (new FilesViewerEndpoint())->run();
}
