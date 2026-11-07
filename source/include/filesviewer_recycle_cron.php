<?php
/* ============================================================================
   FILES VIEWER - recycle bin cron
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */
declare(strict_types=1);
if (PHP_SAPI !== 'cli') exit(1);

require_once __DIR__ . '/filesviewer_api.php';

$_POST = ['mode' => 'expired', 'scope' => 'all'];
$r = FilesViewerEndpoint::recyclePurge();

$purged = (int)($r['purged'] ?? 0);
if ($purged > 0 || empty($r['ok'])) {
    openlog('filesviewer', LOG_PID, LOG_USER);
    if ($purged > 0) syslog(LOG_INFO, 'recycle bin: purged ' . $purged . ' expired event' . ($purged === 1 ? '' : 's'));
    if (empty($r['ok'])) syslog(LOG_WARNING, 'recycle bin: ' . (string)($r['error'] ?? 'purge incomplete'));
    closelog();
}

exit(empty($r['ok']) ? 1 : 0);
