<?php
/* ============================================================================
   FILES VIEWER - zip writer
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

declare(strict_types=1);

final class FilesViewerZip
{
    private const CHUNK = 1048576;

    private $sink;
    private int $level;
    private int $offset = 0;
    private array $dir = [];
    public string $error = '';

    public function __construct(callable $sink, int $level = 6)
    {
        $this->sink  = $sink;
        $this->level = $level;
    }

    private function put(string $buf): bool
    {
        if ($buf === '') return true;
        if (!($this->sink)($buf)) return false;
        $this->offset += strlen($buf);
        return true;
    }

    private static function dosTime(int $ts): int
    {
        $t = getdate(max($ts, 315532800));
        return (($t['year'] - 1980) << 25) | ($t['mon'] << 21) | ($t['mday'] << 16) | ($t['hours'] << 11) | ($t['minutes'] << 5) | intdiv($t['seconds'], 2);
    }

    public function dir(string $name, int $mtime, int $mode): bool
    {
        return $this->entry($name, null, 0, $mtime, $mode, null);
    }

    public function file(string $name, $in, int $size, int $mtime, int $mode, ?callable $tick = null): bool
    {
        return $this->entry($name, $in, $size, $mtime, $mode, $tick);
    }

    private function entry(string $name, $in, int $size, int $mtime, int $mode, ?callable $tick): bool
    {
        $isDir  = ($in === null);
        $big    = $size >= 0xFFBFFFFF;
        $offset = $this->offset;
        $flags  = ($isDir ? 0 : 0x0008) | 0x0800;
        $method = $isDir ? 0 : 8;
        $extra  = $big ? pack('vvPP', 0x0001, 16, 0, 0) : '';
        $hdr = pack('VvvvVVVVvv', 0x04034b50, $big ? 45 : 20, $flags, $method, self::dosTime($mtime),
                    0, $big ? 0xFFFFFFFF : 0, $big ? 0xFFFFFFFF : 0, strlen($name), strlen($extra)) . $name . $extra;
        if (!$this->put($hdr)) return false;

        $crc = 0; $csize = 0; $usize = 0;
        if (!$isDir) {
            $h  = hash_init('crc32b');
            $df = deflate_init(ZLIB_ENCODING_RAW, ['level' => $this->level]);
            while (!feof($in)) {
                $buf = fread($in, self::CHUNK);
                if ($buf === false) { $this->error = 'read failed'; return false; }
                if ($buf === '') continue;
                hash_update($h, $buf);
                $usize += strlen($buf);
                $out = deflate_add($df, $buf, ZLIB_NO_FLUSH);
                $csize += strlen($out);
                if (!$this->put($out)) return false;
                if ($tick !== null && !$tick(strlen($buf))) return false;
            }
            $out = deflate_add($df, '', ZLIB_FINISH);
            $csize += strlen($out);
            if (!$this->put($out)) return false;
            $crc = hexdec(hash_final($h));
            $desc = $big ? pack('VVPP', 0x08074b50, $crc, $csize, $usize) : pack('VVVV', 0x08074b50, $crc, $csize, $usize);
            if (!$this->put($desc)) return false;
        }
        $this->dir[] = [$name, $flags, $method, $mtime, $crc, $csize, $usize, $offset, $mode, $isDir];
        return true;
    }

    public function finish(): bool
    {
        $cdStart = $this->offset;
        foreach ($this->dir as [$name, $flags, $method, $mtime, $crc, $csize, $usize, $offset, $mode, $isDir]) {
            $z64 = ($csize >= 0xFFFFFFFF || $usize >= 0xFFFFFFFF || $offset >= 0xFFFFFFFF);
            $extra = $z64 ? pack('vvPPP', 0x0001, 24, $usize, $csize, $offset) : '';
            $attr = (($mode & 0xFFFF) << 16) | ($isDir ? 0x10 : 0);
            $rec = pack('VvvvvVVVVvvvvvVV', 0x02014b50, 0x031E, $z64 ? 45 : 20, $flags, $method, self::dosTime($mtime), $crc,
                        $z64 ? 0xFFFFFFFF : $csize, $z64 ? 0xFFFFFFFF : $usize, strlen($name), strlen($extra), 0, 0, 0, $attr,
                        $z64 ? 0xFFFFFFFF : $offset) . $name . $extra;
            if (!$this->put($rec)) return false;
        }
        $cdSize = $this->offset - $cdStart;
        $count  = count($this->dir);
        if ($count >= 0xFFFF || $cdSize >= 0xFFFFFFFF || $cdStart >= 0xFFFFFFFF) {
            $eocd64 = $this->offset;
            $rec = pack('VPvvVVPPPP', 0x06064b50, 44, 45, 45, 0, 0, $count, $count, $cdSize, $cdStart);
            $rec .= pack('VVPV', 0x07064b50, 0, $eocd64, 1);
            if (!$this->put($rec)) return false;
        }
        $rec = pack('VvvvvVVv', 0x06054b50, 0, 0, min($count, 0xFFFF), min($count, 0xFFFF),
                    min($cdSize, 0xFFFFFFFF), min($cdStart, 0xFFFFFFFF), 0);
        return $this->put($rec);
    }
}
