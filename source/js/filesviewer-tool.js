/* ============================================================================
   FILES VIEWER
   Copyright (C) 2026 Lazaros Chalkidis
   License: GPLv3
   ========================================================================= */

(function () {
    'use strict';

    var _cfg   = window.filesviewerToolConfig || {};
    var _token = _cfg.fvToken || '';
    var _imgMaxBytes = (Number(_cfg.imgMaxMb) || 50) * 1000 * 1000;
    var _docMaxBytes    = 30 * 1000 * 1000;
    var _ebookMaxBytes  = 60 * 1000 * 1000;
    var _fontMaxBytes   = 15 * 1000 * 1000;
    var _editMaxBytes   = 2 * 1024 * 1024;
    var _autoplay = !!_cfg.autoplay;
    var _remember = (_cfg.remember !== false);
    var _recycleOn = (_cfg.recycle === true);
    var _permsFmt = (_cfg.permsFormat === 'symbolic') ? 'symbolic' : 'octal';
    var _roots    = _cfg.roots || [];

    var T = (typeof window._ === 'function') ? window._ : function (t) { return t; };
    function tf(t) {
        var a = arguments, i = 0;
        return T(t).replace(/%s/g, function () { i++; return i < a.length ? String(a[i]) : ''; });
    }

    function csrfToken() { return _cfg.csrfToken || window.csrf_token || ''; }

    var API   = '/plugins/filesviewer/include/filesviewer_api.php';
    var SERVE = '/plugins/filesviewer/include/filesviewer_serve.php';

    function apiUrl(action, extra) {
        var url = API + '?action=' + encodeURIComponent(action);
        if (extra) url += '&' + extra;
        return url;
    }

    function serveUrl(path, dl) {
        var u = SERVE + '?path=' + encodeURIComponent(path)
              + '&_fvt=' + encodeURIComponent(_token);
        if (dl) u += '&dl=1';
        return u;
    }

    var LS_KEY = 'filesviewer:lastdir:' + (_roots.length ? _roots.join('|') : 'default');
    function saveDir(p) { if (!_remember) return; try { if (p) localStorage.setItem(LS_KEY, p); } catch (e) {} }
    function readDir()  { if (!_remember) return ''; try { return localStorage.getItem(LS_KEY) || ''; } catch (e) { return ''; } }

    var SP_KEY = 'filesviewer:spacejob';
    function spSaveJob(id, path) { try { localStorage.setItem(SP_KEY, JSON.stringify({ id: id, path: path })); } catch (e) {} }
    function spClearJob()        { try { localStorage.removeItem(SP_KEY); } catch (e) {} }
    function spReadJob() {
        try {
            var j = JSON.parse(localStorage.getItem(SP_KEY) || 'null');
            return (j && j.id) ? j : null;
        } catch (e) { return null; }
    }

    var SORT_KEY  = 'filesviewer:sort';
    var SORT_COLS = { name: 1, type: 1, size: 1, modified: 1, owner: 1, group: 1, mode: 1 };
    function defaultSort() {
        return { k: SORT_COLS[_cfg.sort] ? _cfg.sort : 'name', d: _cfg.sortDir === 'desc' ? 'desc' : 'asc' };
    }
    function readSort() {
        try {
            var s = JSON.parse(localStorage.getItem(SORT_KEY) || 'null');
            if (s && SORT_COLS[s.k]) return { k: s.k, d: s.d === 'desc' ? 'desc' : 'asc' };
        } catch (e) {}
        return defaultSort();
    }
    var _sort = readSort();
    function setSort(key) {
        if (!SORT_COLS[key]) return;
        _sort = { k: key, d: (_sort.k === key && _sort.d === 'asc') ? 'desc' : 'asc' };
        var def = defaultSort();
        try {
            if (_sort.k === def.k && _sort.d === def.d) localStorage.removeItem(SORT_KEY);
            else localStorage.setItem(SORT_KEY, JSON.stringify(_sort));
        } catch (e) {}
        resortView();
    }
    function cmpStr(a, b) {
        a = String(a || '').toLowerCase(); b = String(b || '').toLowerCase();
        return a < b ? -1 : (a > b ? 1 : 0);
    }
    function entrySize(e) {
        if (!e.is_dir) return e.size || 0;
        return _measured[e.path] !== undefined ? _measured[e.path] : 0;
    }
    function sortEntries(entries) {
        var foldersFirst = (_cfg.foldersFirst !== false);
        var mul = _sort.d === 'desc' ? -1 : 1;
        entries.sort(function (a, b) {
            if (foldersFirst && a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
            var c;
            switch (_sort.k) {
                case 'size':     c = entrySize(a) - entrySize(b); break;
                case 'modified': c = (a.mtime || 0) - (b.mtime || 0); break;
                case 'type':     c = cmpStr(typeLabel(a), typeLabel(b)); break;
                case 'owner':    c = cmpStr(a.owner, b.owner); break;
                case 'group':    c = cmpStr(a.group, b.group); break;
                case 'mode':     c = cmpStr(permText(a), permText(b)); break;
                default:         c = cmpStr(a.name, b.name);
            }
            if (c === 0) c = cmpStr(a.name, b.name);
            return c * mul;
        });
    }

    function fetchJson(action, extra) {
        return fetch(apiUrl(action, extra), {
            headers: { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-TOKEN': csrfToken() },
            credentials: 'same-origin'
        }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
    }

    function postJson(action, params) {
        var body = 'csrf_token=' + encodeURIComponent(csrfToken());
        for (var k in params) {
            if (Object.prototype.hasOwnProperty.call(params, k)) {
                body += '&' + encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
            }
        }
        return fetch(apiUrl(action), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'X-Requested-With': 'XMLHttpRequest',
                'X-CSRF-TOKEN': csrfToken()
            },
            credentials: 'same-origin',
            body: body
        }).then(function (r) {
            return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status }; });
        });
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    var _libs = {};
    function loadLib(file) {
        if (_libs[file]) return _libs[file];
        _libs[file] = new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = '/plugins/filesviewer/js/vendor/' + file + (_cfg.assetV || '');
            s.onload = function () { resolve(); };
            s.onerror = function () { reject(new Error('could not load ' + file)); };
            document.head.appendChild(s);
        });
        return _libs[file];
    }
    function fetchBytes(path) {
        return fetch(serveUrl(path, false), { credentials: 'same-origin' }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.arrayBuffer();
        });
    }

    function focusedFile() {
        if (singleSelectedFile()) return selectedPaths()[0];
        if (_previewFile && _previewFile.path) return _previewFile.path;
        return null;
    }
    function downloadSelected() {
        var paths = selectedPaths();
        if (paths.length && !singleSelectedFile()) { promptZip(paths); return; }
        var p = focusedFile();
        if (!p) return;
        var a = document.createElement('a');
        a.href = serveUrl(p, true);
        a.setAttribute('download', '');
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
    function promptZip(paths) {
        var def = paths.length === 1 ? baseName(paths[0]) : (baseName(_currentPath || '') || 'files');
        var inner =
            '<label class="fv-field"><span>' + T('Archive name') + '</span>' +
              '<div class="fv-namext"><input type="text" class="fv-input" id="fv-zp-name" autocomplete="off" spellcheck="false" value="' + esc(def) + '">' +
              '<span class="fv-namext__ext">.zip</span></div></label>' +
            '<p class="fv-confirm" id="fv-zp-info" style="color:var(--fv-text-dim)">' +
              (paths.length === 1 ? T('1 item') : tf('%s items', paths.length)) + ' \u00b7 ' + T('measuring') + '\u2026</p>' +
            '<p class="fv-confirm" style="color:var(--fv-text-dim)">' + T('The zip is built while it downloads, so the browser cannot show a total size. Links are left out.') + '</p>' +
            '<div class="fv-modal__err" style="display:none"></div>';
        var ov = modalOpen(T('Download as zip'), inner, T('Download'), 'fv-btn--primary', function (ov) {
            var name = ov.querySelector('#fv-zp-name').value.trim();
            if (!name) { modalError(ov, T('Enter a name.')); return; }
            postDownload(paths, name);
            modalClose();
        });
        var inp = ov.querySelector('#fv-zp-name'); inp.focus(); inp.select();
        postJson('zip_info', { paths: JSON.stringify(paths), _fvt: _token }).then(function (d) {
            var info = ov.querySelector('#fv-zp-info');
            if (!info) return;
            if (!d || !d.ok) { modalError(ov, (d && d.error) || T('Could not read the items.')); modalBusy(ov, true); return; }
            info.textContent = (paths.length === 1 ? T('1 item') : tf('%s items', paths.length)) + ' \u00b7 ' +
                (d.files === 1 ? T('1 file') : tf('%s files', d.files)) + ', ' +
                (d.capped ? tf('more than %s', formatBytes(d.bytes)) : formatBytes(d.bytes));
        }).catch(function () {});
    }
    function postDownload(paths, name) {
        var fr = document.getElementById('fv-dl-frame');
        if (!fr) {
            fr = document.createElement('iframe');
            fr.id = 'fv-dl-frame'; fr.name = 'fv-dl-frame';
            fr.setAttribute('hidden', ''); fr.style.display = 'none';
            document.body.appendChild(fr);
        }
        var f = document.createElement('form');
        f.method = 'post'; f.action = SERVE; f.target = 'fv-dl-frame'; f.style.display = 'none';
        var fields = { csrf_token: csrfToken(), _fvt: _token, zip: '1', paths: JSON.stringify(paths), name: name };
        for (var k in fields) {
            if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
            var i = document.createElement('input');
            i.type = 'hidden'; i.name = k; i.value = fields[k];
            f.appendChild(i);
        }
        document.body.appendChild(f);
        f.submit();
        setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 2000);
    }
    function focusedItem() {
        var p = selectedPaths();
        if (p.length === 1) return p[0];
        return (_previewFile && _previewFile.path) || '';
    }
    function pathForCopy() { return focusedItem() || _currentPath || ''; }
    function locatePath() {
        var p = pathForCopy();
        return /^\/mnt\/[^\/]+\/.+/.test(p) ? p : '';
    }
    function isUserPath(p) { return /^\/mnt\/user0?\/.+/.test(p); }
    function promptLocate() {
        var p = locatePath();
        if (!p) return;
        var name = baseName(p), done = false;
        var fetchIt = function (ov) {
            modalBusy(ov, true);
            fetchJson('locate', 'path=' + encodeURIComponent(p)).then(function (d) {
                if (!d || !d.ok) { modalBusy(ov, false); modalError(ov, (d && d.error) || T('Request failed.')); return; }
                done = true;
                renderLocate(ov, d);
            }).catch(function () { modalBusy(ov, false); modalError(ov, T('Request failed.')); });
        };
        var inner, okLabel;
        if (isUserPath(p)) {
            inner = '<p class="fv-confirm">' + tf('%s sits under /mnt/user, which merges every disk and pool. Look for the same path on each of them?', '<b>' + esc(name) + '</b>') + '</p>' +
                    '<p class="fv-confirm" style="color:var(--fv-warn-text)">' + T('A disk that is asleep may wake up.') + '</p>';
            okLabel = T('Look');
        } else {
            inner = '<p class="fv-confirm">' + T('Looking') + '\u2026</p>';
            okLabel = T('Close');
        }
        var ov = modalOpen(T('Which disk'), inner + '<div class="fv-modal__err" style="display:none"></div>', okLabel, 'fv-btn--primary', function (ov) {
            if (done || !isUserPath(p)) { modalClose(); return; }
            fetchIt(ov);
        });
        ov.classList.add('fv-modal--wide');
        if (!isUserPath(p)) fetchIt(ov);
    }
    function diskCardHtml(r) {
        var bits = [];
        if (r.id) bits.push(esc(r.id));
        if (r.bytes > 0) bits.push(formatBytes(r.bytes));
        if (r.fs) bits.push(esc(r.fs));
        if (r.temp !== null && r.temp !== undefined) bits.push(r.temp + '\u00b0C');
        var h = '<div class="fv-loc__head"><span class="fv-loc__disk">' + esc(r.disk) + '</span>' +
                (r.pool ? '<span class="fv-loc__tag">' + T('pool') + '</span>' : '') +
                (r.device ? '<span class="fv-loc__dev">' + esc(r.device) + '</span>' : '') + '</div>' +
                (bits.length ? '<div class="fv-loc__id">' + bits.join(' \u00b7 ') + '</div>' : '');
        for (var i = 0; i < (r.members || []).length; i++) {
            var m = r.members[i], mb = [];
            if (m.id) mb.push(esc(m.id));
            if (m.bytes > 0) mb.push(formatBytes(m.bytes));
            h += '<div class="fv-loc__id">' + (m.device ? esc(m.device) + ' \u00b7 ' : '') + mb.join(' \u00b7 ') + '</div>';
        }
        return h;
    }
    function renderLocate(ov, d) {
        var rows = d.locations || [], html;
        var what = '<b>' + esc(d.name) + '</b>';
        if (!rows.length) {
            html = '<p class="fv-confirm">' + tf('%s was not found on any of the %s disks and pools. It may have just been removed.', what, d.checked) + '</p>';
        } else {
            html = '<p class="fv-confirm">' + (rows.length === 1
                ? tf('%s is on %s.', what, '<b>' + esc(rows[0].disk) + '</b>')
                : tf('%s is on %s of the %s disks and pools.', what, rows.length, d.checked)) + '</p>';
            html += '<div class="fv-loc">';
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i], go = (d.mode === 'user');
                html += '<div class="fv-loc__row' + (go ? ' fv-loc__row--go' : '') + '" data-path="' + esc(r.path) + '" data-dir="' + (r.is_dir ? '1' : '0') + '" title="' + esc(r.path) + '">' +
                          '<div class="fv-loc__card">' + diskCardHtml(r) + '</div>' +
                          '<div class="fv-loc__meta"><span class="fv-loc__size">' + (r.is_dir ? T('folder') : (r.link ? T('link') : formatBytes(r.size))) + '</span>' +
                          '<span class="fv-loc__date">' + (r.mtime ? fmtDate(r.mtime) : '') + '</span>' +
                          (go ? '<span class="fv-loc__go">' + T('Open') + ' \u203a</span>' : '') + '</div>' +
                        '</div>';
            }
            html += '</div>';
            if (!d.is_dir && rows.length > 1) {
                html += '<p class="fv-confirm" style="color:var(--fv-warn-text)">' + T('The same file sits on more than one disk. /mnt/user shows only one of them, the others are stale copies taking space.') + '</p>';
            }
        }
        var b = ov.querySelector('.fv-modal__body');
        b.innerHTML = html;
        var btn = ov.querySelector('.fv-modal__ok');
        if (btn) { btn.disabled = false; btn.textContent = T('Close'); }
        var cancel = ov.querySelector('.fv-modal__cancel');
        if (cancel) cancel.style.display = 'none';
        b.addEventListener('click', function (e) {
            var row = e.target.closest ? e.target.closest('.fv-loc__row--go') : null;
            if (!row) return;
            var path = row.getAttribute('data-path'), isDir = row.getAttribute('data-dir') === '1';
            modalClose();
            openFound(path, isDir);
        });
    }
    function copyLegacy(text) {
        var ta = document.createElement('textarea');
        ta.value = text; ta.setAttribute('readonly', '');
        ta.style.position = 'fixed'; ta.style.top = '-1000px';
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
        return ok ? Promise.resolve() : Promise.reject(new Error('copy blocked'));
    }
    function copyText(text) {
        if (!navigator.clipboard || !window.isSecureContext) return copyLegacy(text);
        return navigator.clipboard.writeText(text).catch(function () { return copyLegacy(text); });
    }
    var _pathFlash = null;
    function copyPath() {
        var p = pathForCopy();
        if (!p || !_pathBtn) return;
        copyText(p).then(function () {
            var span = _pathBtn.querySelector('span');
            if (_pathFlash) clearTimeout(_pathFlash);
            _pathBtn.classList.add('active');
            if (span) span.textContent = T('Copied');
            _pathFlash = setTimeout(function () {
                _pathBtn.classList.remove('active');
                if (span) span.textContent = T('Copy path');
                _pathFlash = null;
            }, 1200);
        }, function () {
            var ov = modalOpen(T('Copy path'),
                '<label class="fv-field"><span>' + T('The browser did not allow the copy. Select the path and press Ctrl+C.') + '</span>' +
                '<input type="text" class="fv-input" id="fv-cp-path" readonly value="' + esc(p) + '"></label>',
                T('Close'), 'fv-btn--primary', function () { modalClose(); }, true);
            var inp = ov.querySelector('#fv-cp-path'); inp.focus(); inp.select();
        });
    }
    var HASH_ALGOS = ['sha256', 'sha1', 'md5', 'sha512'];
    function entryFor(path) {
        for (var k = 0; k < _lastEntries.length; k++) if (_lastEntries[k].path === path) return _lastEntries[k];
        return null;
    }
    function promptChecksum() {
        var path = focusedFile();
        if (!path) return;
        var ent = entryFor(path) || (_previewFile && _previewFile.path === path ? _previewFile : null) || {};
        var name = ent.name || baseName(path), size = ent.size || 0;
        var opts = '';
        for (var i = 0; i < HASH_ALGOS.length; i++) opts += '<option value="' + HASH_ALGOS[i] + '">' + HASH_ALGOS[i].toUpperCase() + '</option>';
        var inner =
            '<p class="fv-confirm" style="margin-bottom:.6rem"><b>' + esc(name) + '</b> \u00b7 ' + formatBytes(size) + '</p>' +
            '<div class="fv-namext"><select class="fv-input" id="fv-hash-algo">' + opts + '</select>' +
              '<button type="button" class="fv-btn fv-btn--primary" id="fv-hash-go">' + T('Compute') + '</button></div>' +
            '<div class="fv-prog" id="fv-hash-prog" style="display:none"><div class="fv-prog-bar"><div class="fv-prog-fill" id="fv-hash-fill"></div></div>' +
              '<div class="fv-prog-row"><span id="fv-hash-pct">0%</span><span id="fv-hash-eta"></span></div></div>' +
            '<label class="fv-field" id="fv-hash-out" style="display:none"><span id="fv-hash-label"></span>' +
              '<div class="fv-namext"><input type="text" class="fv-input fv-mono" id="fv-hash-val" readonly><button type="button" class="fv-btn" id="fv-hash-copy">' + T('Copy') + '</button></div></label>' +
            '<label class="fv-field" id="fv-hash-cmp" style="display:none"><span>' + T('Paste a checksum to compare') + '</span>' +
              '<input type="text" class="fv-input fv-mono" id="fv-hash-exp" autocomplete="off" spellcheck="false"></label>' +
            '<div class="fv-sp-line" id="fv-hash-res"></div>' +
            '<div class="fv-modal__err" style="display:none"></div>';
        var jobId = '', timer = null, t0 = 0;
        var ov = modalOpen(T('Checksum'), inner, T('Close'), 'fv-btn--primary', function () { modalClose(); }, true);
        ov.classList.add('fv-modal--wide');
        _modalOnClose = function () { if (timer) clearInterval(timer); if (jobId) postJson('job_cancel', { id: jobId }); };

        function stop() { if (timer) { clearInterval(timer); timer = null; } jobId = ''; }
        function compare() {
            var exp = (ov.querySelector('#fv-hash-exp').value.match(/[0-9a-fA-F]{32,128}/) || [''])[0].toLowerCase();
            var got = ov.querySelector('#fv-hash-val').value;
            var res = ov.querySelector('#fv-hash-res');
            if (!exp || !got) { res.textContent = ''; res.className = 'fv-sp-line'; return; }
            var same = exp === got;
            res.textContent = same ? T('Match.') : T('No match.');
            res.className = 'fv-sp-line ' + (same ? 'fv-hash-ok' : 'fv-sp-warn');
        }
        function paint(st) {
            var bt = Number(st.bytes_total) || 0, bd = Number(st.bytes_done) || 0;
            var pct = bt > 0 ? Math.min(100, Math.round(bd / bt * 100)) : 0;
            ov.querySelector('#fv-hash-fill').style.width = pct + '%';
            ov.querySelector('#fv-hash-pct').textContent = pct + '% \u00b7 ' + formatBytes(bd);
            var el = (Date.now() - t0) / 1000, eta = '';
            if (bd > 0 && bt > bd && el > 1) {
                var rem = Math.round((bt - bd) / (bd / el));
                eta = rem > 90 ? tf('~%sm left', Math.round(rem / 60)) : tf('~%ss left', rem);
            }
            ov.querySelector('#fv-hash-eta').textContent = eta;
        }
        function finish(st) {
            stop();
            ov.querySelector('#fv-hash-prog').style.display = 'none';
            var go = ov.querySelector('#fv-hash-go'); go.disabled = false; go.textContent = T('Compute');
            if (st.state === 'done' && st.hash) {
                ov.querySelector('#fv-hash-label').textContent = (st.algo || '').toUpperCase() + (st.elapsed != null ? ' \u00b7 ' + tf('%ss', st.elapsed) : '');
                ov.querySelector('#fv-hash-val').value = st.hash;
                ov.querySelector('#fv-hash-out').style.display = '';
                ov.querySelector('#fv-hash-cmp').style.display = '';
                compare();
            } else if (st.state === 'cancelled') {
                modalError(ov, T('Cancelled.'));
            } else {
                modalError(ov, (st.message || T('Something went wrong.')));
            }
        }
        function poll() {
            fetchJson('job_status', 'id=' + encodeURIComponent(jobId)).then(function (d) {
                if (!jobId) return;
                if (!d || !d.ok) { finish({ state: 'error', message: (d && d.error) || T('job lost') }); return; }
                var st = d.status || {};
                if (st.state === 'done' || st.state === 'cancelled' || st.state === 'error') { finish(st); return; }
                try { paint(st); } catch (e) {}
            });
        }
        ov.querySelector('#fv-hash-go').addEventListener('click', function () {
            var go = this;
            if (jobId) { postJson('job_cancel', { id: jobId }); go.disabled = true; return; }
            modalError(ov, '');
            ov.querySelector('#fv-hash-out').style.display = 'none';
            ov.querySelector('#fv-hash-res').textContent = '';
            postJson('checksum_start', { path: path, algo: ov.querySelector('#fv-hash-algo').value }).then(function (d) {
                if (!d || !d.ok) { modalError(ov, (d && d.error) || T('Could not start.')); return; }
                jobId = d.id; t0 = Date.now();
                go.textContent = T('Cancel');
                ov.querySelector('#fv-hash-fill').style.width = '0%';
                ov.querySelector('#fv-hash-pct').textContent = '0%';
                ov.querySelector('#fv-hash-eta').textContent = '';
                ov.querySelector('#fv-hash-prog').style.display = '';
                timer = setInterval(poll, 500);
                poll();
            });
        });
        ov.querySelector('#fv-hash-copy').addEventListener('click', function () {
            var b = this, v = ov.querySelector('#fv-hash-val').value;
            if (!v) return;
            copyText(v).then(function () { b.textContent = T('Copied'); setTimeout(function () { b.textContent = T('Copy'); }, 1200); }, function () {
                var inp = ov.querySelector('#fv-hash-val'); inp.focus(); inp.select();
            });
        });
        ov.querySelector('#fv-hash-exp').addEventListener('input', compare);
    }
    function openRawSelected() {
        var p = singleSelectedFile() ? selectedPaths()[0] : _selectedFile;
        if (!p) return;
        window.open(serveUrl(p, false), '_blank', 'noopener');
    }
    function toggleWrap() {
        var pre = _bodyEl ? _bodyEl.querySelector('.fv-code') : null;
        if (!pre) return;
        var on = !pre.classList.contains('wrap-on');
        pre.classList.toggle('wrap-on', on);
        pre.classList.toggle('wrap-off', !on);
        if (_wrapBtn) _wrapBtn.classList.toggle('active', on);
    }
    var _rawOk = false;
    function setFileTools(canWrap, canRaw, canEdit, editNote) {
        if (_wrapBtn) {
            _wrapBtn.disabled = !canWrap; _wrapBtn.classList.toggle('active', canWrap);
            whyOff(_wrapBtn, T('Toggle line wrapping'), T('Open a text file first'));
        }
        _rawOk = !!canRaw;
        if (_rawBtn) {
            _rawBtn.disabled = !(_rawOk || singleSelectedFile());
            whyOff(_rawBtn, T('Open the file in a new tab'), T('Open or tick a file first'));
        }
        _editable = !!canEdit;
        _editNote = editNote || '';
        refreshEditBtn();
    }
    function refreshEditBtn() {
        if (!_editBtn) return;
        _editBtn.disabled = !(_editable && _editMode);
        _editBtn.title = _editNote ||
            (_editable && !_editMode ? T('Turn on editing with the eye icon first') : T('Edit'));
    }

    function editNote(size) {
        return (size || 0) > _editMaxBytes
            ? tf('Too large to edit here, the editor takes files up to %s', formatBytes(_editMaxBytes))
            : '';
    }

    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        var units = ['B','KB','MB','GB','TB','PB'];
        var i = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
        var val = bytes / Math.pow(1000, i);
        var str = (i >= 3) ? val.toFixed(2).replace(/\.?0+$/, '') : String(Math.round(val));
        return str + ' ' + units[i];
    }

    function formatDate(epoch) {
        if (!epoch) return '';
        try { return new Date(epoch * 1000).toLocaleString(); }
        catch (e) { return ''; }
    }

    var CAT_LABEL = {
        dir: T('Folder'), img: T('Image'), code: T('Text'), md: T('Markdown'), pdf: 'PDF',
        audio: T('Audio'), video: T('Video'), arch: T('Archive'), bin: T('File'),
        sqlite: T('Database'), doc: T('Document'), sheet: T('Spreadsheet'), ebook: T('E-book'), font: T('Font')
    };
    var CAT_TAG = {
        dir: '', img: 'IMG', code: '{}', md: 'MD', pdf: 'PDF',
        audio: '\u266a', video: '\u25b6', arch: 'ZIP', bin: 'BIN',
        sqlite: 'DB', doc: 'DOC', sheet: 'XLS', ebook: 'BK', font: 'Aa'
    };

    function extColor(ext) {
        var s = String(ext || '').toLowerCase();
        if (!s) return null;
        var h = 2166136261;
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
        h ^= h >>> 13; h = (h * 0x5bd1e995) >>> 0; h ^= h >>> 15;
        var hue = (h >>> 0) % 360;
        return { bg: 'hsla(' + hue + ',55%,50%,.18)', fg: 'hsl(' + hue + ',62%,68%)' };
    }
    var FILE_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 2h7l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V8h4.5z"/></svg>';
    var FOLDER_SVG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>';

    var ICON_COLOR = {
        img: '#1f7ae0', code: '#2f6fe0', md: '#7c3aed', pdf: '#d83a2c',
        audio: '#d98a1f', video: '#2a82d6', arch: '#4b5563', bin: '#4b5563',
        sqlite: '#0f9d6b', doc: '#2f63d6', sheet: '#1f9d57', ebook: '#7a45c8', font: '#c43d7a'
    };
    function extColorDark(ext) {
        var s = String(ext || '').toLowerCase();
        if (!s) return '#4b5563';
        var h = 2166136261;
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
        h ^= h >>> 13; h = (h * 0x5bd1e995) >>> 0; h ^= h >>> 15;
        return 'hsl(' + ((h >>> 0) % 360) + ',60%,42%)';
    }
    var DOC_PAGE = 'M14 2 H6 a2 2 0 0 0 -2 2 v16 a2 2 0 0 0 2 2 h12 a2 2 0 0 0 2 -2 V8 Z';
    var DOC_FOLD = 'M14 2 v6 h6';
    function fileIconSvg(cat, ext) {
        var tag = CAT_TAG[cat] || 'BIN';
        var color = (cat === 'bin') ? extColorDark(ext) : (ICON_COLOR[cat] || '#4b5563');
        var fs = tag.length <= 1 ? 13 : (tag.length === 2 ? 10 : 7.5);
        var svg = '<svg class="fv-docicon" width="30" height="30" viewBox="0 0 24 24" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
            '<path d="' + DOC_PAGE + '" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/>' +
            '<path d="' + DOC_FOLD + ' Z" fill="#e8e8e8"/>' +
            '<path d="' + DOC_FOLD + '" fill="none" stroke="#000" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>' +
        '</svg>';
        return svg + '<span class="fv-doc__tag" style="color:' + color + ';font-size:' + fs + 'px">' + esc(tag) + '</span>';
    }

    var _listEl, _crumbEl, _bodyEl, _titleEl, _countEl, _pvTypeEl, _pvToolsEl, _filterEl, _pvEl, _pvCloseEl, _dlBtn, _wrapBtn, _rawBtn;
    var _filterWideEl = null, _filterNarrowEl = null, _sideBtn = null;
    var _createBtn, _renameBtn, _deleteBtn, _editBtn, _ownerBtn, _permBtn, _copyBtn, _moveBtn, _uploadBtn, _recycleBtn, _spaceBtn, _compressBtn, _pathBtn, _locateBtn, _searchBtn, _hashBtn, _rootEl;
    var _editMode = false;
    var _editable = false;
    var _editNote = '';
    var _inFolder = false;
    var _currentCrumbs = [];
    var _hasManyRoots = false;
    var EMPTY_HTML = '';
    var _lastEntries = [];
    var _lastData = null;
    var _lastParent = '';
    var _canPick = false;
    var _lastPick = null;
    var _measured = {};
    var SIDE_KEY = 'filesviewer:sidebar';
    function sideOn()  { try { return localStorage.getItem(SIDE_KEY) === '1'; } catch (e) { return false; } }
    function sideSet(v) { try { localStorage.setItem(SIDE_KEY, v ? '1' : '0'); } catch (e) {} }
    var _split = false;
    var _currentPath = '';
    var _starEl = null, _favBtn = null, _favMenuEl = null;
    var _selectedFile = null;
    var _selected = {};
    var _previewFile = null;
    var _editing = false;
    var _editBaseline = '';
    var _editMtime = 0;
    var _editCtx = null;

    function setLoading(target) {
        target.innerHTML =
            '<div class="fv-loading">' +
              '<div class="fv-loading__bars">' +
                '<div class="fv-loading__bar"></div><div class="fv-loading__bar"></div>' +
                '<div class="fv-loading__bar"></div><div class="fv-loading__bar"></div>' +
                '<div class="fv-loading__bar"></div>' +
              '</div>' +
              '<div class="fv-loading__text">' + T('Reading') + '\u2026</div>' +
            '</div>';
    }

    function errorBox(msg) { return '<div class="fv-error">' + esc(msg) + '</div>'; }

    function setPvHead(name, typeText, cat) {
        resetPaneModes();
        renderPathCrumbs(name || null);
        if (_pvTypeEl) {
            _pvTypeEl.textContent = typeText || '';
            _pvTypeEl.className = 'fv-preview__type' + (typeText && cat ? ' fv-pt-' + cat : '');
            _pvTypeEl.style.background = '';
            _pvTypeEl.style.color = '';
            if (cat === 'bin' && typeText && typeText.charAt(0) === '.') {
                var c = extColor(typeText.slice(1));
                if (c) { _pvTypeEl.style.background = c.bg; _pvTypeEl.style.color = c.fg; }
            }
        }
        _pvToolsEl.innerHTML = '';
        setFileTools(false, false);
        if (_pvEl) _pvEl.classList.add('fv-preview--active');
    }

    function folderOverviewHtml() {
        var q = (_filterEl && _filterEl.value) ? _filterEl.value.trim().toLowerCase() : '';
        var rows = [];
        for (var n = 0; n < _lastEntries.length; n++) {
            if (q === '' || _lastEntries[n].name.toLowerCase().indexOf(q) !== -1) rows.push(_lastEntries[n]);
        }
        if (!rows.length && !_lastParent) return '';

        var pick = _editMode;
        var h = '<div class="fv-fo"><table class="fv-fo__t"><thead><tr>' +
                  (pick ? '<th class="fv-fo__c"><input type="checkbox" id="fv-fo-all" aria-label="' + T('Select all') + '"></th>' : '') +
                  thHtml('name', T('Name'), 'fv-fo__nm') +
                  thHtml('type', T('Type'), '') + thHtml('size', T('Size'), 'fv-fo__r') + thHtml('modified', T('Modified'), '') +
                  thHtml('owner', T('Owner'), '') + thHtml('group', T('Group'), '') + thHtml('mode', T('Mode'), '') +
                '</tr></thead><tbody>';

        var cols = pick ? 8 : 7;
        if (_lastParent) {
            h += '<tr class="fv-fo__row fv-fo__row--up" data-path="' + esc(_lastParent) + '" data-dir="1">' +
                   (pick ? '<td class="fv-fo__c"></td>' : '') +
                   '<td colspan="' + (pick ? cols - 1 : cols) + '"><span class="fv-fo__ico">' + FOLDER_SVG + '</span>..</td></tr>';
        }
        for (var i = 0; i < rows.length; i++) h += foRowHtml(rows[i], pick);
        if (!rows.length) {
            h += '<tr><td colspan="' + cols + '" class="fv-fo__none">' +
                 (q === '' ? T('This folder is empty.') : T('Nothing matches the filter.')) + '</td></tr>';
        }
        return h + '</tbody></table></div>';
    }

    function thHtml(key, label, cls) {
        var on = (_sort.k === key);
        return '<th class="fv-fo__h' + (cls ? ' ' + cls : '') + (on ? ' fv-fo__h--on' : '') + '" data-key="' + key + '"' +
               ' title="' + T('Sort by this column') + '">' + label +
               '<i class="fv-fo__arr" aria-hidden="true">' + (on && _sort.d === 'desc' ? '\u25be' : '\u25b4') + '</i></th>';
    }

    function permText(e) { return (_permsFmt === 'symbolic') ? (e.perms || '') : (e.mode || ''); }
    function typeLabel(e) {
        var ty = e.is_dir ? T('Folder') : (CAT_LABEL[e.category] || T('File'));
        return e.link ? tf('%s link', ty) : ty;
    }

    function foRowHtml(e, pick) {
        var pv = permText(e);
        var ty = typeLabel(e);
        return '<tr class="fv-fo__row' + (_selected[e.path] ? ' selected' : '') + '"' +
                 ' data-path="' + esc(e.path) + '" data-dir="' + (e.is_dir ? '1' : '0') + '">' +
                 (pick ? '<td class="fv-fo__c"><input type="checkbox" class="fv-focb"' + (_selected[e.path] ? ' checked' : '') + ' aria-label="' + T('Select') + '"></td>' : '') +
                 '<td class="fv-fo__nm"><span class="fv-fo__ico">' + (e.is_dir ? FOLDER_SVG : FILE_SVG) + '</span>' + esc(e.name) + '</td>' +
                 '<td>' + esc(ty) + '</td>' +
                 '<td class="fv-fo__r">' + sizeCell(e) + '</td>' +
                 '<td>' + (e.mtime ? fmtDate(e.mtime) : '') + '</td>' +
                 '<td>' + esc(e.owner || '') + '</td>' +
                 '<td>' + esc(e.group || '') + '</td>' +
                 '<td>' + esc(pv) + '</td>' +
               '</tr>';
    }

    function sizeCell(e) {
        if (!e.is_dir) return formatBytes(e.size);
        if (_measured[e.path] !== undefined) return formatBytes(_measured[e.path]);
        if (!_cfg.space) return '';
        return '<button type="button" class="fv-fo__meas">' + T('Measure') + '</button>';
    }

    function openFolderRow(tr, path) {
        var slow = setTimeout(function () {
            var row = _bodyEl.querySelector('.fv-fo__row[data-path="' + cssEsc(path) + '"]');
            var cell = row ? row.querySelector('td') : null;
            if (!cell || cell.querySelector('.fv-fo__wait')) return;
            cell.insertAdjacentHTML('beforeend',
                '<span class="fv-fo__wait">' + T('waiting for the disk') + '<i></i><i></i><i></i></span>');
        }, 400);

        loadDir(path).then(function () { clearTimeout(slow); })
                     .catch(function () { clearTimeout(slow); });
    }

    function cssEsc(v) {
        return String(v).replace(/["\\]/g, '\\$&');
    }

    function measureRow(td, path) {
        td.textContent = '\u2026';
        postJson('space_start', { path: path }).then(function (d) {
            if (!d || !d.ok) { td.textContent = '?'; td.title = d && d.error ? d.error : 'failed'; return; }
            var t = setInterval(function () {
                fetchJson('job_status', 'id=' + encodeURIComponent(d.id)).then(function (r) {
                    var st = r && r.ok && r.status;
                    if (!st) { clearInterval(t); td.textContent = '?'; return; }
                    if (st.state === 'running' || st.state === 'queued') return;
                    clearInterval(t);
                    if (st.state === 'done') {
                        _measured[path] = st.bytes || 0;
                        td.textContent = formatBytes(_measured[path]);
                    } else {
                        td.textContent = '?';
                    }
                }).catch(function () { clearInterval(t); td.textContent = '?'; });
            }, 600);
        });
    }

    function paneOpen() { return _uploadMode || _spaceMode || _searchMode || _recycleMode; }
    function showFolderOverview() {
        if (_split || !_bodyEl || paneOpen()) return;
        var h = folderOverviewHtml();
        if (h) { _bodyEl.innerHTML = h; syncTableChecks(); }
    }

    function setSplit(on) {
        _split = !!on;
        var g = document.querySelector('.fv-grid');
        if (g) g.classList.toggle('fv-grid--split', _split);
        if (_sideBtn) {
            _sideBtn.setAttribute('aria-pressed', _split ? 'true' : 'false');
            _sideBtn.title = _split ? T('Hide the folder list') : T('Show the folder list');
        }
        var from = _split ? _filterWideEl : _filterNarrowEl;
        var to   = _split ? _filterNarrowEl : _filterWideEl;
        if (from && to) to.value = from.value;
        _filterEl = to;
        sideSet(_split);
        if (!_previewFile && !paneOpen()) { _bodyEl.innerHTML = EMPTY_HTML; showFolderOverview(); }
    }

    var _pvGen = 0;
    function clearPreview() {
        _pvGen++;
        resetPaneModes();
        _bodyEl.innerHTML = EMPTY_HTML;
        showFolderOverview();
        if (_pvTypeEl) {
            _pvTypeEl.textContent = '';
            _pvTypeEl.className = 'fv-preview__type';
            _pvTypeEl.style.background = '';
            _pvTypeEl.style.color = '';
        }
        _pvToolsEl.innerHTML = '';
        renderPathCrumbs(null);
        _selectedFile = null;
        _previewFile = null;
        markActive(null);
        _editable = false;
        resetEditState();
        setFileTools(false, false);
        updateOps();
        if (_pvEl) _pvEl.classList.remove('fv-preview--active');
    }

    function addTool(label, title, onClick) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'fv-pv-btn';
        b.title = title || label;
        b.textContent = label;
        b.addEventListener('click', onClick);
        _pvToolsEl.appendChild(b);
        return b;
    }

    function buildCrumbsHtml(crumbs, hasManyRoots, fileName) {
        if (!crumbs || !crumbs.length) {
            return '<span class="fv-crumb cur">' + T('Roots') + '</span>';
        }
        var html = '<span class="fv-crumb-label">' + T('Path') + ':</span>';
        if (hasManyRoots) {
            html += '<a class="fv-crumb" data-path="">' + T('Roots') + '</a><span class="fv-crumb-sep">/</span>';
        }
        for (var i = 0; i < crumbs.length; i++) {
            var last = (i === crumbs.length - 1);
            if (last && !fileName) {
                html += '<span class="fv-crumb cur">' + esc(crumbs[i].name) + '</span>';
            } else {
                html += '<a class="fv-crumb" data-path="' + esc(crumbs[i].path) + '">' + esc(crumbs[i].name) + '</a>'
                      + '<span class="fv-crumb-sep">/</span>';
            }
        }
        if (fileName) html += '<span class="fv-crumb cur">' + esc(fileName) + '</span>';
        return html;
    }
    function renderPathCrumbs(fileName) {
        if (_crumbEl) _crumbEl.innerHTML = buildCrumbsHtml(_currentCrumbs, _hasManyRoots, fileName || null);
    }
    function renderCrumbs(crumbs, isRoot, hasManyRoots) {
        _currentCrumbs = crumbs || [];
        _hasManyRoots = !!hasManyRoots;
        renderPathCrumbs(null);
    }

    function fmtDate(ts) {
        var d = new Date(ts * 1000);
        var p = function (n) { return n < 10 ? '0' + n : String(n); };
        return d.getFullYear() + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate()) +
               ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function itemSub(e) {
        var pv = (_permsFmt === 'symbolic') ? (e.perms || '') : (e.mode || '');
        var h  = '';
        if (!e.is_dir) h += '<span class="fv-sub__cell">' + formatBytes(e.size) + '</span>';
        if (e.owner)   h += '<span class="fv-sub__cell fv-sub__owner">' + esc(e.owner) + '</span>';
        if (pv)        h += '<span class="fv-sub__cell">' + esc(pv) + '</span>';
        if (e.mtime)   h += '<span class="fv-sub__cell">' + fmtDate(e.mtime) + '</span>';
        return h;
    }

    function renderList(data, keepSel) {
        var entries = data.entries || [];
        if (!data.root_picker) sortEntries(entries);
        _lastEntries = entries;
        _lastData    = data;
        _lastParent  = (!data.is_root && data.parent) ? data.parent : '';
        _titleEl.textContent = data.root_picker ? T('Roots') : T('Contents');
        _listEl.setAttribute('data-trunc', data.truncated ? '1' : '0');
        if (!keepSel) _selected = {};

        var sel = !data.root_picker;
        _canPick = sel;
        var cb  = sel ? '<label class="fv-item__cb"><input type="checkbox" class="fv-rowcb" aria-label="' + T('Select') + '"></label>' : '';
        var html = '';

        if (!data.is_root && data.parent) {
            html += '<div class="fv-item fv-item--up" data-dir="1" data-path="' + esc(data.parent) + '">' +
                      (sel ? '<span class="fv-item__cb"></span>' : '') +
                      '<div class="fv-ico dir">' + FOLDER_SVG + '</div>' +
                      '<div class="fv-item__meta"><div class="fv-item__name">..</div>' +
                      '<div class="fv-item__sub"><span class="fv-sub__cell">' + T('Parent folder') + '</span></div></div>' +
                    '</div>';
        }

        if (!entries.length) {
            _listEl.innerHTML = html + '<div class="fv-list-empty">' + T('This folder is empty.') + '</div>';
            if (_countEl) _countEl.textContent = '';
            updateOps();
            return;
        }

        for (var i = 0; i < entries.length; i++) {
            var e   = entries[i];
            var cat = e.is_dir ? 'dir' : (e.category || 'bin');
            var ico = e.is_dir ? FOLDER_SVG : fileIconSvg(cat, e.ext);

            html += '<div class="fv-item"' +
                      ' data-dir="' + (e.is_dir ? '1' : '0') + '"' +
                      ' data-path="' + esc(e.path) + '"' +
                      ' data-cat="'  + esc(cat) + '"' +
                      ' data-size="' + (e.size || 0) + '"' +
                      ' data-name="' + esc(e.name) + '"' +
                      ' data-ext="'  + esc(e.ext || '') + '">' +
                      cb +
                      '<div class="fv-ico ' + (e.is_dir ? 'dir' : 'fv-ico--doc') + '">' + ico + '</div>' +
                      '<div class="fv-item__meta">' +
                        '<div class="fv-item__name">' + esc(e.name) + '</div>' +
                        '<div class="fv-item__sub">' + itemSub(e) + '</div>' +
                      '</div>' +
                    '</div>';
        }
        if (data.truncated) {
            html += '<div class="fv-list-note">' + tf('Only the first %s items are shown. Use the filter on a narrower folder to see the rest.', entries.length) + '</div>';
        }
        _listEl.innerHTML = html;
        if (keepSel) syncListChecks();
        if (!_previewFile) showFolderOverview();
        updateOps();
    }

    function resortView() {
        if (!_lastData || _lastData.root_picker) return;
        var active = _previewFile ? _previewFile.path : null;
        renderList(_lastData, true);
        applyFilter();
        if (active) markActive(active);
        updateSelUi();
    }

    function orderedPaths() {
        var q = (_filterEl && _filterEl.value) ? _filterEl.value.trim().toLowerCase() : '';
        var out = [];
        for (var i = 0; i < _lastEntries.length; i++) {
            if (q === '' || _lastEntries[i].name.toLowerCase().indexOf(q) !== -1) out.push(_lastEntries[i].path);
        }
        return out;
    }
    function pickRange(path, on) {
        var order = orderedPaths();
        var a = order.indexOf(_lastPick), b = order.indexOf(path);
        if (a < 0 || b < 0) return false;
        for (var i = Math.min(a, b); i <= Math.max(a, b); i++) {
            if (on) _selected[order[i]] = true; else delete _selected[order[i]];
        }
        return true;
    }
    function onPickClick(e) {
        var t = e.target;
        if (!t || t.type !== 'checkbox' || !t.classList || !(t.classList.contains('fv-focb') || t.classList.contains('fv-rowcb'))) return;
        var row = t.closest('.fv-fo__row, .fv-item');
        var path = row ? row.getAttribute('data-path') : null;
        if (!path) return;
        if (e.shiftKey && _lastPick && _lastPick !== path && pickRange(path, t.checked)) {
            syncListChecks();
            updateSelUi();
        }
        _lastPick = path;
    }
    function onPickDown(e) {
        if (e.shiftKey && e.target && e.target.closest && e.target.closest('.fv-fo__c, .fv-item__cb')) e.preventDefault();
    }
    function selectAllVisible() {
        var order = orderedPaths();
        _selected = {};
        for (var i = 0; i < order.length; i++) _selected[order[i]] = true;
        syncListChecks();
        updateSelUi();
    }

    function markActive(path) {
        var items = _listEl.querySelectorAll('.fv-item');
        for (var i = 0; i < items.length; i++) {
            items[i].classList.toggle('active',
                items[i].getAttribute('data-path') === path && items[i].getAttribute('data-dir') === '0');
        }
        refreshStar();
    }

    function renderImage(path, name) {
        setPvHead(name, T('Image'), 'img');
        _bodyEl.innerHTML = '<div class="fv-imgwrap" id="fv-imgwrap"><img class="fv-img fit" id="fv-img" alt=""></div>';
        var wrap = document.getElementById('fv-imgwrap');
        var img  = document.getElementById('fv-img');
        var gen = _pvGen;
        img.onerror = function () { if (gen === _pvGen) loadMeta(path, T('This file could not be shown as an image.')); };
        img.src = serveUrl(path, false);
        img.addEventListener('dragstart', function (e) { e.preventDefault(); });

        var fit = true, fitBtn;
        function toggleFit() {
            fit = !fit;
            img.classList.toggle('fit', fit);
            wrap.classList.toggle('actual', !fit);
            img.style.cursor = fit ? 'zoom-in' : 'zoom-out';
            if (fitBtn) { fitBtn.textContent = fit ? T('Actual size') : T('Fit'); fitBtn.classList.toggle('active', !fit); }
            if (!fit) {
                wrap.scrollLeft = (wrap.scrollWidth  - wrap.clientWidth)  / 2;
                wrap.scrollTop  = (wrap.scrollHeight - wrap.clientHeight) / 2;
            }
        }
        fitBtn = addTool(T('Actual size'), T('Switch between fit and actual size'), toggleFit);
        addTool(T('Full screen'), T('Show the image full screen, with arrows to the other images in the folder'), function () { openLightbox(path); });
        img.style.cursor = 'zoom-in';

        var dragging = false, moved = false, sx = 0, sy = 0, sl = 0, st = 0;
        wrap.addEventListener('pointerdown', function (e) {
            if (fit || e.button !== 0) return;
            e.preventDefault();
            dragging = true; moved = false;
            sx = e.clientX; sy = e.clientY; sl = wrap.scrollLeft; st = wrap.scrollTop;
            if (wrap.setPointerCapture) wrap.setPointerCapture(e.pointerId);
        });
        wrap.addEventListener('pointermove', function (e) {
            if (!dragging) return;
            var dx = e.clientX - sx, dy = e.clientY - sy;
            if (!moved && Math.abs(dx) + Math.abs(dy) > 4) { moved = true; wrap.classList.add('panning'); }
            if (moved) { wrap.scrollLeft = sl - dx; wrap.scrollTop = st - dy; }
        });
        function dragEnd() { dragging = false; wrap.classList.remove('panning'); }
        wrap.addEventListener('pointerup', dragEnd);
        wrap.addEventListener('pointercancel', dragEnd);

        wrap.addEventListener('click', function (e) {
            if (moved) { moved = false; return; }
            if (fit && e.target !== img) return;
            toggleFit();
        });
        setFileTools(false, true);
    }

    var _lb = null;
    var LB_PREV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>';
    var LB_NEXT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>';
    var LB_X    = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

    function folderImages() {
        var q = (_filterEl && _filterEl.value) ? _filterEl.value.trim().toLowerCase() : '';
        var out = [];
        for (var i = 0; i < _lastEntries.length; i++) {
            var e = _lastEntries[i];
            if (e.is_dir || e.category !== 'img' || !(e.size > 0) || e.size > _imgMaxBytes) continue;
            if (q !== '' && e.name.toLowerCase().indexOf(q) === -1) continue;
            out.push(e);
        }
        return out;
    }

    function openLightbox(path) {
        closeLightbox(false);
        var list = folderImages(), idx = -1;
        for (var i = 0; i < list.length; i++) if (list[i].path === path) { idx = i; break; }
        if (idx < 0) { list = [{ path: path, name: baseName(path), size: 0 }]; idx = 0; }

        var ov = document.createElement('div');
        ov.className = 'fv-lb fv-lb--loading';
        ov.innerHTML =
            '<img class="fv-lb__img" alt="">' +
            '<div class="fv-lb__nav fv-lb__nav--prev" role="button" tabindex="0" aria-label="' + T('Previous') + '">' + LB_PREV + '</div>' +
            '<div class="fv-lb__nav fv-lb__nav--next" role="button" tabindex="0" aria-label="' + T('Next') + '">' + LB_NEXT + '</div>' +
            '<div class="fv-lb__close" role="button" tabindex="0" aria-label="' + T('Close') + '">' + LB_X + '</div>' +
            '<div class="fv-lb__cap"><span class="fv-lb__name"></span><span class="fv-lb__count"></span></div>';
        document.body.appendChild(ov);
        var prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        var img = ov.querySelector('.fv-lb__img');
        var prev = ov.querySelector('.fv-lb__nav--prev'), next = ov.querySelector('.fv-lb__nav--next');
        var nameEl = ov.querySelector('.fv-lb__name'), countEl = ov.querySelector('.fv-lb__count');
        var lb = { ov: ov, list: list, idx: idx, overflow: prevOverflow, full: false, keys: null };
        _lb = lb;

        function show(i) {
            if (i < 0 || i >= list.length) return;
            lb.idx = i;
            var e = list[i];
            ov.classList.add('fv-lb--loading');
            ov.classList.remove('fv-lb--broken');
            img.src = serveUrl(e.path, false);
            nameEl.textContent = e.name + (e.size ? ' \u00b7 ' + formatBytes(e.size) : '');
            countEl.textContent = list.length > 1 ? tf('%s of %s', i + 1, list.length) : '';
            prev.classList.toggle('fv-lb__nav--off', i === 0);
            next.classList.toggle('fv-lb__nav--off', i === list.length - 1);
            if (i + 1 < list.length) { var a = new Image(); a.src = serveUrl(list[i + 1].path, false); }
            if (i > 0) { var b = new Image(); b.src = serveUrl(list[i - 1].path, false); }
        }
        img.addEventListener('load', function () { ov.classList.remove('fv-lb--loading'); });
        img.addEventListener('error', function () { ov.classList.remove('fv-lb--loading'); ov.classList.add('fv-lb--broken'); nameEl.textContent = list[lb.idx].name + ' \u00b7 ' + T('could not be shown'); });
        img.addEventListener('dragstart', function (e) { e.preventDefault(); });

        prev.addEventListener('click', function (e) { e.stopPropagation(); show(lb.idx - 1); });
        next.addEventListener('click', function (e) { e.stopPropagation(); show(lb.idx + 1); });
        ov.querySelector('.fv-lb__close').addEventListener('click', function (e) { e.stopPropagation(); closeLightbox(true); });
        ov.addEventListener('click', function (e) { if (e.target === ov || e.target === img) closeLightbox(true); });

        lb.keys = function (e) {
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); show(lb.idx + 1); }
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); show(lb.idx - 1); }
            else if (e.key === 'Home') { e.preventDefault(); show(0); }
            else if (e.key === 'End') { e.preventDefault(); show(list.length - 1); }
            else if (e.key === 'Escape') { e.preventDefault(); closeLightbox(true); }
            else return;
            e.stopPropagation();
        };
        document.addEventListener('keydown', lb.keys, true);
        lb.fsc = function () { if (_lb === lb && lb.full && !document.fullscreenElement) closeLightbox(true); };
        document.addEventListener('fullscreenchange', lb.fsc);
        if (ov.requestFullscreen) {
            var r = ov.requestFullscreen();
            lb.full = true;
            if (r && r.catch) r.catch(function () { lb.full = false; });
        }
        show(idx);
    }

    function closeLightbox(follow) {
        var lb = _lb;
        if (!lb) return;
        _lb = null;
        document.removeEventListener('keydown', lb.keys, true);
        document.removeEventListener('fullscreenchange', lb.fsc);
        if (lb.full && document.fullscreenElement === lb.ov && document.exitFullscreen) document.exitFullscreen().catch(function () {});
        if (lb.ov.parentNode) lb.ov.parentNode.removeChild(lb.ov);
        document.body.style.overflow = lb.overflow;
        var cur = lb.list[lb.idx];
        if (follow && cur && (!_previewFile || _previewFile.path !== cur.path)) {
            var row = findRow(cur.path);
            if (row) { openFile(row); if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' }); }
        }
    }

    function mediaError(path, kind) {
        var gen = _pvGen;
        return function () {
            if (gen === _pvGen) loadMeta(path, tf('This %s could not be played in the browser. The container or codec may be unsupported.', kind));
        };
    }

    function renderVideo(path, name) {
        setPvHead(name, T('Video'), 'video');
        _bodyEl.innerHTML =
            '<div class="fv-mediawrap">' +
              '<div class="fv-videobox">' +
                '<video id="fv-media" class="fv-video" controls playsinline preload="metadata"' + (_autoplay ? ' autoplay' : '') + '></video>' +
              '</div>' +
              '<div class="fv-media-note">' + T('If playback does not start, the container or codec may not be supported by the browser (for example MKV or H.265).') + '</div>' +
            '</div>';
        var v = document.getElementById('fv-media');
        v.addEventListener('error', mediaError(path, T('video')));
        v.src = serveUrl(path, false);
        setFileTools(false, true);
    }

    function renderAudio(path, name) {
        setPvHead(name, T('Audio'), 'audio');
        _bodyEl.innerHTML =
            '<div class="fv-mediawrap fv-mediawrap--audio">' +
              '<audio id="fv-media" class="fv-audio" controls preload="metadata"' + (_autoplay ? ' autoplay' : '') + '></audio>' +
            '</div>';
        var a = document.getElementById('fv-media');
        a.addEventListener('error', mediaError(path, T('audio')));
        a.src = serveUrl(path, false);
        setFileTools(false, true);
    }

    function truncatedBanner(d) {
        return d.truncated
            ? '<div class="fv-trunc">' + T('Showing the first part only. This file is larger than the preview limit.') + '</div>'
            : '';
    }

    function loadPreview(path, name, ext) {
        var gen = _pvGen;
        setLoading(_bodyEl);
        setPvHead(name, ext ? ('.' + ext) : '', 'code');
        fetchJson('preview', 'path=' + encodeURIComponent(path)).then(function (d) {
            if (gen !== _pvGen) return;
            if (!d || !d.ok) { _bodyEl.innerHTML = errorBox((d && d.error) || T('Could not read this file.')); return; }
            if (d.kind === 'text') {
                if (ext === 'csv' || ext === 'tsv') renderCsv(d, path, name, ext);
                else                                renderText(d, path, name, ext);
            }
            else if (d.kind === 'markdown') renderMarkdown(d, path, name);
            else                            loadMeta(path);
        }).catch(function () { if (gen === _pvGen) _bodyEl.innerHTML = errorBox(T('Request failed.')); });
    }

    function renderText(d, path, name, ext) {
        setPvHead(name, ext ? ('.' + ext) : T('Text'), 'code');
        _bodyEl.innerHTML = truncatedBanner(d);

        var text = d.content || '';
        var big = text.length > 120000;

        var pre = document.createElement('pre');
        pre.className = 'fv-code wrap-on' + (big ? ' fv-code--big' : '');

        if (big) {
            var inner = document.createElement('div');
            inner.className = 'fv-code__inner';
            var lines = text.split('\n');
            for (var i = 0; i < lines.length; i += 400) {
                var ch = document.createElement('div');
                ch.className = 'fv-code__chunk';
                ch.textContent = lines.slice(i, i + 400).join('\n');
                inner.appendChild(ch);
            }
            pre.appendChild(inner);
            _bodyEl.appendChild(pre);
        } else {
            var code = document.createElement('code');
            if (d.language) code.className = 'language-' + d.language;
            code.textContent = text;
            pre.appendChild(code);
            _bodyEl.appendChild(pre);
            try { if (window.hljs) window.hljs.highlightElement(code); } catch (e) {}
        }

        if (ext === 'csv' || ext === 'tsv') {
            addTool(T('Table'), T('Show as a table'), function () { renderCsv(d, path, name, ext); });
        }
        setFileTools(true, true, (d.size || 0) <= _editMaxBytes, editNote(d.size));
    }

    function renderMarkdown(d, path, name) {
        setPvHead(name, T('Markdown'), 'md');
        var rendered = true;

        function highlightInside() {
            try {
                if (window.hljs) {
                    _bodyEl.querySelectorAll('.fv-md pre code').forEach(function (c) { window.hljs.highlightElement(c); });
                }
            } catch (e) {}
        }
        function showRendered() {
            var html;
            try { html = window.marked ? window.marked.parse(d.content) : ('<pre>' + esc(d.content) + '</pre>'); }
            catch (e) { html = '<pre>' + esc(d.content) + '</pre>'; }
            if (!window.DOMPurify) { _bodyEl.innerHTML = truncatedBanner(d) + '<pre class="fv-code wrap-on">' + esc(d.content) + '</pre>'; return; }
            html = window.DOMPurify.sanitize(html);
            _bodyEl.innerHTML = truncatedBanner(d) + '<div class="fv-md">' + html + '</div>';
            highlightInside();
        }
        function showSource() {
            var pre  = document.createElement('pre');
            pre.className = 'fv-code wrap-on';
            var code = document.createElement('code');
            code.className = 'language-markdown';
            code.textContent = d.content;
            pre.appendChild(code);
            _bodyEl.innerHTML = truncatedBanner(d);
            _bodyEl.appendChild(pre);
            try { if (window.hljs) window.hljs.highlightElement(code); } catch (e) {}
        }

        showRendered();

        var srcBtn = addTool(T('View source'), T('Toggle rendered or source'), function () {
            rendered = !rendered;
            if (rendered) showRendered(); else showSource();
            srcBtn.textContent = rendered ? T('View source') : T('View rendered');
            srcBtn.classList.toggle('active', !rendered);
        });
        setFileTools(false, true, (d.size || 0) <= _editMaxBytes, editNote(d.size));
    }

    function loadMeta(path, note) {
        var gen = _pvGen;
        markActive(path);
        setLoading(_bodyEl);
        setPvHead(T('Preview'), '');
        fetchJson('meta', 'path=' + encodeURIComponent(path)).then(function (m) {
            if (gen === _pvGen) renderMeta(m, note);
        }).catch(function () { if (gen === _pvGen) _bodyEl.innerHTML = errorBox(T('Request failed.')); });
    }

    function renderMeta(m, note) {
        if (!m || !m.ok) { _bodyEl.innerHTML = errorBox(T('This file could not be read.')); return; }

        setPvHead(m.name, m.ext ? ('.' + m.ext) : (CAT_LABEL[m.category] || ''), m.category);

        var rows = [
            [T('Type'),     (CAT_LABEL[m.category] || T('File')) + (m.ext ? ' (.' + esc(m.ext) + ')' : '')],
            [T('Size'),     formatBytes(m.size)],
            [T('Modified'), formatDate(m.mtime)],
            [T('Type id'),  esc(m.mime)],
            [T('Perms'),    esc((_permsFmt === 'symbolic') ? (m.perms || m.mode) : (m.mode || m.perms))],
            [T('Path'),     esc(m.path)]
        ];
        var table = '';
        for (var i = 0; i < rows.length; i++) {
            table += '<div><span>' + rows[i][0] + '</span><span>' + rows[i][1] + '</span></div>';
        }

        var msg = note || T('This file has no preview available.');
        _bodyEl.innerHTML =
            '<div class="fv-meta">' +
              '<div class="fv-meta__msg">' + esc(msg) + '</div>' +
              '<div class="fv-meta__table">' + table + '</div>' +
            '</div>';
    }

    function renderPdf(path, name) {
        setPvHead(name, 'PDF', 'pdf');
        _bodyEl.innerHTML = '<div class="fv-pdfwrap"><iframe class="fv-pdf" id="fv-pdf" title="' + T('PDF preview') + '"></iframe></div>';
        document.getElementById('fv-pdf').src = serveUrl(path, false);
        setFileTools(false, true);
    }

    function loadArchive(path, name) {
        var gen = _pvGen;
        setLoading(_bodyEl);
        setPvHead(name, T('Archive'), 'arch');
        fetchJson('archive', 'path=' + encodeURIComponent(path)).then(function (d) {
            if (gen !== _pvGen) return;
            if (!d || !d.ok) { _bodyEl.innerHTML = errorBox((d && d.error) || T('Could not read this archive.')); return; }
            if (d.kind === 'archive') renderArchive(d, path, name);
            else loadMeta(path, T('Listing for this archive type is not supported yet.'));
        }).catch(function () { if (gen === _pvGen) _bodyEl.innerHTML = errorBox(T('Request failed.')); });
    }

    function renderArchive(d, path, name) {
        setPvHead(name, T('Archive'), 'arch');
        var rows = d.entries || [];
        var ex   = d.extract || null;

        var head = '<div class="fv-arch-head"><span>' +
            tf('%s entries', (d.count || 0) + (d.truncated ? '+' : '')) +
            (d.truncated ? ' ' + tf('(showing the first %s)', d.count) : '') +
            ' \u00b7 ' + T('listing only, nothing is extracted') + '</span>' +
            (ex && rows.length ? '<button type="button" class="fv-btn fv-btn--primary" id="fv-arch-extract"' +
                ' data-folder="' + esc(ex.folder) + '" data-taken="' + (ex.taken ? '1' : '0') + '">' + T('Extract') + '</button>' : '') +
            '</div>';

        if (!rows.length) {
            _bodyEl.innerHTML = head + '<div class="fv-list-empty">' + T('No entries, or this archive could not be listed.') + '</div>';
            return;
        }

        var html = '<div class="fv-arch">';
        for (var i = 0; i < rows.length; i++) {
            var r   = rows[i];
            var ico = r.is_dir ? FOLDER_SVG : 'FILE';
            html += '<div class="fv-arch-row">' +
                      '<span class="fv-ico ' + (r.is_dir ? 'dir' : 'bin') + ' fv-arch-ico">' + ico + '</span>' +
                      '<span class="fv-arch-name">' + esc(r.name) + '</span>' +
                      '<span class="fv-arch-size">' + (r.is_dir ? '' : formatBytes(r.size)) + '</span>' +
                    '</div>';
        }
        html += '</div>';

        _bodyEl.innerHTML = head + html;
        refreshExtractBtn();
        var xb = document.getElementById('fv-arch-extract');
        if (xb) xb.addEventListener('click', function () { promptExtract(path, name, ex.folder); });
    }

    function refreshExtractBtn() {
        var b = document.getElementById('fv-arch-extract');
        if (!b) return;
        var folder = b.getAttribute('data-folder') || '';
        var taken  = b.getAttribute('data-taken') === '1';
        b.disabled = !_editMode;
        b.title = !_editMode ? T('Switch on editing to extract')
                : tf('Unpack next to the archive, into a folder named %s unless it holds a single file or folder', folder) +
                  (taken ? ' ' + T('(the name is taken, so a number is added)') : '');
    }

    function promptCompress() {
        var paths = selectedPaths();
        if (!paths.length) return;
        var stem = paths.length === 1 ? baseName(paths[0]).replace(/\.(zip|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar|gz|bz2|xz|7z|rar)$/i, '') : baseName(_currentPath || '/');
        var inner =
            '<label class="fv-field"><span>' + T('Archive name') + '</span>' +
              '<div class="fv-namext"><input type="text" class="fv-input" id="fv-cx-name" autocomplete="off" spellcheck="false" value="' + esc(stem) + '">' +
              '<select class="fv-input" id="fv-cx-fmt"><option value="zip">.zip</option><option value="tgz">.tar.gz</option></select></div></label>' +
            '<p class="fv-confirm" style="color:var(--fv-text-dim)">' +
              (paths.length === 1 ? tf('%s goes in, next to it. Links are left out.', '<b>' + esc(baseName(paths[0])) + '</b>')
                                  : tf('%s items go in, next to them. Links are left out.', paths.length)) + '</p>' +
            '<div class="fv-modal__err" style="display:none"></div>';
        var ov = modalOpen(T('Compress'), inner, T('Compress'), 'fv-btn--primary', function (ov) {
            var name = ov.querySelector('#fv-cx-name').value.trim();
            if (!name) { modalError(ov, T('Enter a name.')); return; }
            modalBusy(ov, true);
            postJson('compress', { sources: JSON.stringify(paths), name: name, format: ov.querySelector('#fv-cx-fmt').value }).then(function (d) {
                if (!d || !d.ok) { modalError(ov, (d && d.error) || T('Could not start.')); modalBusy(ov, false); return; }
                openProgress('compress', d.job);
            });
        });
        var inp = ov.querySelector('#fv-cx-name'); inp.focus(); inp.select();
    }

    function promptExtract(path, name, folder) {
        var inner =
            '<p class="fv-confirm">' + tf('Extract %s next to it?', '<b>' + esc(name) + '</b>') + '</p>' +
            '<p class="fv-confirm" style="color:var(--fv-text-dim)">' +
            tf('A single file or folder inside comes out as itself, anything more goes into a folder named %s. A name that is taken gets a number.', '<b>' + esc(folder) + '</b>') + ' ' +
            T('Links and special entries in the archive are left out.') + ' ' +
            T('What comes out takes the owner and permissions of this folder, not what the archive says.') + '</p>' +
            '<div class="fv-modal__err" style="display:none"></div>';
        modalOpen(T('Extract'), inner, T('Extract'), 'fv-btn--primary', function (ov) {
            modalBusy(ov, true);
            postJson('extract', { path: path }).then(function (d) {
                if (!d || !d.ok) { modalError(ov, (d && d.error) || T('Could not start.')); modalBusy(ov, false); return; }
                openProgress('extract', d.job);
            });
        });
    }

    function loadDir(path, fromInit) {
        return new Promise(function (resolve) {
            leaveEditOk(function () { resolve(loadDirNow(path, fromInit)); },
                        function () { resolve(); });
        });
    }

    function loadDirNow(path, fromInit) {
        _currentPath = path || '';
        _lastPick = null;
        clearPreview();
        clearFilter();
        setLoading(_listEl);
        return fetchJson('list', 'path=' + encodeURIComponent(_currentPath)).then(function (data) {
            if (!data || !data.ok) {
                if (fromInit && _currentPath !== '') { loadDir('', false); return; }
                _listEl.innerHTML = errorBox((data && data.error) || T('Could not read this folder.'));
                return;
            }
            var manyRoots = (data.roots && data.roots.length > 1);
            _currentPath = data.path || '';
            saveDir(_currentPath);
            _inFolder = !!data.path;
            renderCrumbs(data.breadcrumb, data.is_root, manyRoots);
            renderList(data);
            applyFilter();
        }).catch(function () {
            if (fromInit && _currentPath !== '') { loadDir('', false); return; }
            _listEl.innerHTML = errorBox(T('Request failed.'));
        });
    }

    function renderCsv(d, path, name, ext) {
        setPvHead(name, (ext ? '.' + ext : 'CSV'), 'code');
        _bodyEl.innerHTML = truncatedBanner(d) + '<div class="fv-csvwrap" id="fv-csvwrap"></div>';
        var wrap = document.getElementById('fv-csvwrap'), gen = _pvGen;
        setLoading(wrap);
        loadLib('papaparse.min.js').then(function () {
            if (gen !== _pvGen) return;
            var parsed = window.Papa.parse(d.content || '', {
                delimiter: (ext === 'tsv') ? '\t' : '',
                skipEmptyLines: true
            });
            var rows = (parsed && parsed.data) || [];
            if (!rows.length) { wrap.innerHTML = errorBox(T('No rows to show.')); return; }
            var head = rows[0], html = '<table class="fv-table"><thead><tr>';
            for (var i = 0; i < head.length; i++) html += '<th>' + esc(String(head[i])) + '</th>';
            html += '</tr></thead><tbody>';
            for (var r = 1; r < rows.length; r++) {
                html += '<tr>';
                var row = rows[r];
                for (var k = 0; k < row.length; k++) html += '<td>' + esc(String(row[k])) + '</td>';
                html += '</tr>';
            }
            wrap.innerHTML = html + '</tbody></table>';
        }).catch(function () { if (gen === _pvGen) wrap.innerHTML = errorBox(T('Could not parse this file.')); });

        addTool(T('Raw'), T('Show as plain text'), function () { renderText(d, path, name, ext); });
        setFileTools(false, true);
    }

    var _db = null;

    function renderSqlite(path, name) {
        setPvHead(name, T('Database'), 'sqlite');
        setLoading(_bodyEl);
        _db = null;
        var gen = _pvGen;
        fetchJson('db_info', 'path=' + encodeURIComponent(path)).then(function (d) {
            if (gen !== _pvGen) return;
            if (!d || !d.ok) { _bodyEl.innerHTML = errorBox((d && d.error) || T('Could not open this database.')); return; }
            _db = { path: path, name: name, info: d };
            renderDbTables();
        }).catch(function () { if (gen === _pvGen) _bodyEl.innerHTML = errorBox(T('Request failed.')); });
    }

    var DB_TABLE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 5h18M3 10h18M3 15h18M3 20h18M8 5v15M16 5v15"/></svg>';

    function renderDbTables() {
        if (!_db) return;
        var d = _db.info;
        var tables = d.tables || [];
        var nt = 0, nv = 0;
        tables.forEach(function (t) { if (t.kind === 'view') nv++; else nt++; });

        var html = '<div class="fv-db2">' +
            '<div class="fv-db2-head"><b>' + esc(_db.name) + '</b> \u00b7 ' + formatBytes(d.size || 0) +
            ' \u00b7 SQLite ' + esc(d.sqlite || '?') + ' \u00b7 ' + (nt === 1 ? tf('%s table', nt) : tf('%s tables', nt)) +
            (nv ? ', ' + (nv === 1 ? tf('%s view', nv) : tf('%s views', nv)) : '') +
            ' \u00b7 ' + (d.immutable ? T('opened read only, no locks') : T('opened read only')) + '</div>';
        if (d.wal) html += '<div class="fv-db2-warn">' + T('Write ahead log present: recent changes by the running app may not appear here.') + '</div>';
        if (d.counts_partial) html += '<div class="fv-db2-note">' + T('Some row counts were skipped to keep this large database quick to open.') + '</div>';

        if (!tables.length) {
            html += '<div class="fv-list-empty">' + T('No tables found in this database.') + '</div>';
        } else {
            html += '<div class="fv-db2-list">';
            tables.forEach(function (t, i) {
                var meta = (t.cols === 1 ? tf('%s col', t.cols) : tf('%s cols', t.cols));
                if (t.rows !== null && t.rows !== undefined) meta += ' \u00b7 ' + (t.rows === 1 ? tf('%s row', t.rows.toLocaleString()) : tf('%s rows', t.rows.toLocaleString()));
                html += '<div class="fv-db2-trow" data-i="' + i + '">' +
                          '<span class="fv-db2-tico">' + DB_TABLE_SVG + '</span>' +
                          '<span class="fv-db2-tname">' + esc(t.name) + '</span>' +
                          (t.kind === 'view' ? '<span class="fv-db2-badge">' + T('view') + '</span>' : '') +
                          '<span class="fv-db2-tmeta">' + meta + '</span>' +
                        '</div>';
            });
            html += '</div>';
        }
        html += '</div>';
        _bodyEl.innerHTML = html;

        _bodyEl.querySelector('.fv-db2').addEventListener('click', function (e) {
            var row = e.target && e.target.closest ? e.target.closest('.fv-db2-trow') : null;
            if (!row) return;
            var t = tables[parseInt(row.getAttribute('data-i'), 10)];
            if (t) loadDbRows(t.name, 0);
        });
    }

    function loadDbRows(table, offset) {
        if (!_db) return;
        var gen = _pvGen;
        setLoading(_bodyEl);
        fetchJson('db_rows', 'path=' + encodeURIComponent(_db.path) +
                             '&table=' + encodeURIComponent(table) +
                             '&offset=' + offset + '&limit=100').then(function (d) {
            if (!_db || gen !== _pvGen) return;
            if (!d || !d.ok) {
                _bodyEl.innerHTML = '<div class="fv-db2"><div class="fv-db2-top"><button type="button" class="fv-btn" id="fv-db-back">\u2190 ' + T('Tables') + '</button></div>' +
                                    errorBox((d && d.error) || T('Could not read this table.')) + '</div>';
                var bk = _bodyEl.querySelector('#fv-db-back');
                if (bk) bk.addEventListener('click', renderDbTables);
                return;
            }
            renderDbGrid(d);
        }).catch(function () { if (gen === _pvGen) _bodyEl.innerHTML = errorBox(T('Request failed.')); });
    }

    function renderDbGrid(d) {
        var cols = d.columns || [], rows = d.rows || [];
        var from = d.offset + 1, to = d.offset + rows.length;

        var html = '<div class="fv-db2 fv-db2--grid">' +
            '<div class="fv-db2-top">' +
              '<button type="button" class="fv-btn" id="fv-db-back">\u2190 ' + T('Tables') + '</button>' +
              '<span class="fv-db2-ttitle">' + esc(d.table) + '</span>' +
              (rows.length
                  ? '<span class="fv-db2-range">' + tf('rows %s to %s', from.toLocaleString(), to.toLocaleString()) + '</span>'
                  : '<span class="fv-db2-norows">' + T('No rows') + '</span>') +
            '</div>';

        if (!rows.length && d.offset === 0) {
            html += '<div class="fv-list-empty">' + T('This table is empty.') + '</div>';
        } else {
            html += '<div class="fv-tablewrap"><table class="fv-table"><thead><tr>';
            cols.forEach(function (c) { html += '<th>' + esc(String(c)) + '</th>'; });
            html += '</tr></thead><tbody>';
            rows.forEach(function (r) {
                html += '<tr>';
                r.forEach(function (v) {
                    if (v === null) html += '<td><i class="fv-db2-null">null</i></td>';
                    else if (typeof v === 'string' && v.indexOf('[blob ') === 0) html += '<td><span class="fv-db2-blob">' + esc(v) + '</span></td>';
                    else html += '<td>' + esc(String(v)) + '</td>';
                });
                html += '</tr>';
            });
            html += '</tbody></table></div>';
        }

        html += '<div class="fv-db2-foot">' +
                  '<span class="fv-db2-note">' + T('Values over 300 characters are clipped') + ' \u00b7 ' + T('blobs shown by size') + '</span>' +
                  '<span class="fv-db2-page">' +
                    '<button type="button" class="fv-btn" id="fv-db-prev"' + (d.offset > 0 ? '' : ' disabled') + '>\u2190 ' + T('Prev 100') + '</button>' +
                    '<button type="button" class="fv-btn" id="fv-db-next"' + (d.more ? '' : ' disabled') + '>' + T('Next 100') + ' \u2192</button>' +
                  '</span>' +
                '</div></div>';
        _bodyEl.innerHTML = html;

        var bk = _bodyEl.querySelector('#fv-db-back');
        if (bk) bk.addEventListener('click', renderDbTables);
        var pv = _bodyEl.querySelector('#fv-db-prev');
        if (pv) pv.addEventListener('click', function () { loadDbRows(d.table, Math.max(0, d.offset - d.limit)); });
        var nx = _bodyEl.querySelector('#fv-db-next');
        if (nx) nx.addEventListener('click', function () { loadDbRows(d.table, d.offset + d.limit); });
    }

    function renderDoc(path, name) {
        setPvHead(name, T('Document'), 'doc');
        setLoading(_bodyEl);
        var gen = _pvGen;
        Promise.all([loadLib('mammoth.browser.min.js'), fetchBytes(path)]).then(function (res) {
            return window.mammoth.convertToHtml({ arrayBuffer: res[1] });
        }).then(function (out) {
            if (gen !== _pvGen) return;
            if (!window.DOMPurify) { _bodyEl.innerHTML = errorBox(T('The sanitiser did not load, so this document cannot be shown.')); return; }
            var html = window.DOMPurify.sanitize((out && out.value) || '');
            _bodyEl.innerHTML = '<div class="fv-doc">' + html + '</div>';
        }).catch(function () { if (gen === _pvGen) _bodyEl.innerHTML = errorBox(T('Could not render this document.')); });
    }

    function renderSheet(path, name) {
        setPvHead(name, T('Spreadsheet'), 'sheet');
        setLoading(_bodyEl);
        var gen = _pvGen;
        Promise.all([loadLib('xlsx.full.min.js'), fetchBytes(path)]).then(function (res) {
            if (gen !== _pvGen) return;
            var wb = window.XLSX.read(new Uint8Array(res[1]), { type: 'array' });
            var names = wb.SheetNames || [];
            if (!names.length) { _bodyEl.innerHTML = errorBox(T('This spreadsheet has no sheets.')); return; }
            var tabs = '';
            for (var i = 0; i < names.length; i++) tabs += '<button type="button" class="fv-sheet__tab' + (i === 0 ? ' active' : '') + '" data-sheet="' + esc(names[i]) + '">' + esc(names[i]) + '</button>';
            _bodyEl.innerHTML = '<div class="fv-sheet"><div class="fv-sheet__tabs">' + tabs + '</div><div class="fv-tablewrap" id="fv-sheet-view"></div></div>';
            function show(n) {
                var view = document.getElementById('fv-sheet-view');
                if (!window.DOMPurify) { view.innerHTML = errorBox(T('The sanitiser did not load, so this sheet cannot be shown.')); return; }
                view.innerHTML = window.DOMPurify.sanitize(window.XLSX.utils.sheet_to_html(wb.Sheets[n], { editable: false }));
            }
            var tabsEl = _bodyEl.querySelectorAll('.fv-sheet__tab');
            for (var j = 0; j < tabsEl.length; j++) {
                tabsEl[j].addEventListener('click', function () {
                    for (var x = 0; x < tabsEl.length; x++) tabsEl[x].classList.remove('active');
                    this.classList.add('active');
                    show(this.getAttribute('data-sheet'));
                });
            }
            show(names[0]);
        }).catch(function () { if (gen === _pvGen) _bodyEl.innerHTML = errorBox(T('Could not open this spreadsheet.')); });
    }

    function renderFont(path, name, ext) {
        setPvHead(name, (ext ? '.' + ext : T('Font')), 'font');
        setLoading(_bodyEl);
        var gen = _pvGen;
        fetchBytes(path).then(function (buf) {
            var fam = 'fvfont_' + Date.now();
            var face = new FontFace(fam, buf);
            return face.load().then(function (loaded) {
                if (gen !== _pvGen) return;
                document.fonts.add(loaded);
                var pangram = T('The quick brown fox jumps over the lazy dog');
                var glyphs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ\nabcdefghijklmnopqrstuvwxyz\n0123456789  .,:;!?()[]{}/\\&@#%';
                var sizes = [40, 30, 22, 16], lines = '';
                for (var i = 0; i < sizes.length; i++) lines += '<div class="fv-font__line" style="font-size:' + sizes[i] + 'px">' + esc(pangram) + '</div>';
                _bodyEl.innerHTML =
                    '<div class="fv-font" style="font-family:\'' + fam + '\',sans-serif">' +
                      '<pre class="fv-font__glyphs">' + esc(glyphs) + '</pre>' +
                      lines +
                    '</div>';
            });
        }).catch(function () { if (gen === _pvGen) _bodyEl.innerHTML = errorBox(T('Could not load this font.')); });
    }

    function renderEbook(path, name) {
        setPvHead(name, T('E-book'), 'ebook');
        setLoading(_bodyEl);
        var gen = _pvGen;
        loadLib('jszip.min.js').then(function () {
            return loadLib('epub.min.js');
        }).then(function () {
            return fetchBytes(path);
        }).then(function (buf) {
            if (gen !== _pvGen) return;
            _bodyEl.innerHTML =
                '<div class="fv-ebook">' +
                  '<div class="fv-ebook__view" id="fv-ebook-view"></div>' +
                  '<div class="fv-ebook__nav">' +
                    '<button type="button" class="fv-pv-btn" id="fv-ebook-prev">' + T('Previous') + '</button>' +
                    '<button type="button" class="fv-pv-btn" id="fv-ebook-next">' + T('Next') + '</button>' +
                  '</div>' +
                '</div>';
            var book = window.ePub(buf);
            var rendition = book.renderTo('fv-ebook-view', { width: '100%', height: '100%', flow: 'scrolled-doc' });
            rendition.display();
            document.getElementById('fv-ebook-prev').addEventListener('click', function () { rendition.prev(); });
            document.getElementById('fv-ebook-next').addEventListener('click', function () { rendition.next(); });
        }).catch(function () { if (gen === _pvGen) _bodyEl.innerHTML = errorBox(T('Could not open this e-book.')); });
    }

    function doOpen(cat, size, name, ext, path) {
        if (cat === 'img')                       renderImage(path, name);
        else if (cat === 'code' || cat === 'md') loadPreview(path, name, ext);
        else if (cat === 'audio')                renderAudio(path, name);
        else if (cat === 'video')                renderVideo(path, name);
        else if (cat === 'pdf')                  renderPdf(path, name);
        else if (cat === 'arch')                 loadArchive(path, name);
        else if (cat === 'sqlite')               renderSqlite(path, name);
        else if (cat === 'doc')                  renderDoc(path, name);
        else if (cat === 'sheet')                renderSheet(path, name);
        else if (cat === 'ebook')                renderEbook(path, name);
        else if (cat === 'font')                 renderFont(path, name, ext);
        else                                     loadMeta(path);
    }

    function sidecarNote(name) {
        var m = /^(.*\.(?:db|db3|sqlite|sqlite3))-(wal|shm|journal)$/i.exec(name);
        if (!m) return '';
        var what = { wal: T('write-ahead log'), shm: T('shared memory file'), journal: T('rollback journal') }[m[2]];
        return tf('This is the SQLite %s for %s, not a database of its own. Open that file to browse the data.', what, m[1]);
    }

    function openFile(item) {
        leaveEditOk(function () { openFileNow(item); });
    }

    function openFileNow(item) {
        var path = item.getAttribute('data-path');
        var cat  = item.getAttribute('data-cat') || 'bin';
        var size = Number(item.getAttribute('data-size') || '0');
        var name = item.getAttribute('data-name') || '';
        var ext  = item.getAttribute('data-ext') || '';

        _pvGen++;
        _selectedFile = path;
        _previewFile = { path: path, cat: cat, size: size, name: name, ext: ext };
        markActive(path);
        _editable = false;
        refreshEditBtn();
        updateOps();

        var willRead = (cat === 'code' || cat === 'md' || cat === 'audio' || cat === 'video'
                        || cat === 'pdf' || cat === 'arch'
                        || (cat === 'img'    && size > 0 && size <= _imgMaxBytes)
                        || cat === 'sqlite'
                        || (cat === 'doc'    && size > 0 && size <= _docMaxBytes)
                        || (cat === 'sheet'  && size > 0 && size <= _docMaxBytes)
                        || (cat === 'ebook'  && size > 0 && size <= _ebookMaxBytes)
                        || (cat === 'font'   && size > 0 && size <= _fontMaxBytes));

        if (!willRead) {
            var caps = { img:   [_imgMaxBytes,   T('images')],
                         doc:   [_docMaxBytes,   T('documents')],
                         sheet: [_docMaxBytes,   T('spreadsheets')],
                         ebook: [_ebookMaxBytes, T('e-books')],
                         font:  [_fontMaxBytes,  T('fonts')] };
            var cap = caps[cat];
            loadMeta(path, (cap && size > 0)
                ? tf('This file is over the %s preview limit for %s.', formatBytes(cap[0]), cap[1])
                : sidecarNote(name));
            return;
        }

        doOpen(cat, size, name, ext, path);
    }

    function clearFilter() {
        if (_filterEl && _filterEl.value !== '') _filterEl.value = '';
    }

    function applyFilter() {
        if (!_filterEl) return;
        var q = _filterEl.value.trim().toLowerCase();
        var items = _listEl.querySelectorAll('.fv-item');
        var shown = 0, total = 0;
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.classList.contains('fv-item--up')) continue;
            total++;
            var name = (it.getAttribute('data-name') || '').toLowerCase();
            var match = (q === '' || name.indexOf(q) !== -1);
            it.style.display = match ? '' : 'none';
            if (match) shown++;
        }
        if (_countEl) {
            var trunc = (_listEl.getAttribute('data-trunc') === '1');
            _countEl.textContent = (q === '')
                ? (total ? (total === 1 && !trunc ? T('1 item') : tf('%s items', total + (trunc ? '+' : ''))) : '')
                : tf('%s of %s', shown, total + (trunc ? '+' : ''));
        }
        if (!_previewFile) showFolderOverview();
    }

    function visibleItems() {
        return Array.prototype.filter.call(_listEl.querySelectorAll('.fv-item'), function (el) {
            return el.style.display !== 'none';
        });
    }
    function kbdIndex(items) {
        for (var i = 0; i < items.length; i++) if (items[i].classList.contains('kbd')) return i;
        return -1;
    }
    function setKbd(items, idx) {
        for (var i = 0; i < items.length; i++) items[i].classList.toggle('kbd', i === idx);
        if (idx >= 0 && items[idx] && items[idx].scrollIntoView) items[idx].scrollIntoView({ block: 'nearest' });
    }
    function onKey(e) {
        if (!_listEl || _modal || _lb) return;
        var tag = e.target && e.target.tagName;
        var inFilter = (e.target === _filterEl);
        var inField = (tag === 'INPUT' && e.target.type !== 'checkbox') || tag === 'TEXTAREA' || tag === 'SELECT';
        if (inField && !inFilter) return;

        if (!inFilter && (e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'a' || e.key === 'A')) {
            if (!_editMode || !_canPick || _previewFile) return;
            e.preventDefault();
            selectAllVisible();
            return;
        }
        if (!inFilter && e.key === 'Delete' && _deleteBtn && !_deleteBtn.disabled) { e.preventDefault(); promptDelete(); return; }
        if (!inFilter && e.key === 'F2' && _renameBtn && !_renameBtn.disabled) { e.preventDefault(); promptRename(); return; }

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            var items = visibleItems();
            if (!items.length) return;
            e.preventDefault();
            var i = kbdIndex(items);
            i = (e.key === 'ArrowDown')
                ? ((i < 0) ? 0 : Math.min(items.length - 1, i + 1))
                : ((i < 0) ? 0 : Math.max(0, i - 1));
            setKbd(items, i);
        } else if (e.key === 'Enter') {
            var its = visibleItems();
            var f = kbdIndex(its);
            var target = (f >= 0) ? its[f] : null;
            if (!target) {
                for (var k = 0; k < its.length; k++) {
                    if (!its[k].classList.contains('fv-item--up')) { target = its[k]; break; }
                }
            }
            if (target) {
                e.preventDefault();
                if (target.getAttribute('data-dir') === '1') loadDir(target.getAttribute('data-path'));
                else openFile(target);
            }
        } else if (e.key === 'Escape') {
            if (_filterEl && _filterEl.value !== '') { clearFilter(); applyFilter(); }
            else if (_previewFile || _spaceMode || _searchMode) leaveEditOk(clearPreview);
        }
    }

    function onListClick(ev) {
        if (ev.target.closest && ev.target.closest('.fv-item__cb')) { onPickClick(ev); return; }
        var item = ev.target.closest ? ev.target.closest('.fv-item') : null;
        if (!item) return;
        if (item.getAttribute('data-dir') === '1') { loadDir(item.getAttribute('data-path')); return; }
        if (_previewFile && _previewFile.path === item.getAttribute('data-path')) {
            leaveEditOk(clearPreview);
            return;
        }
        openFile(item);
    }

    function onCrumbClick(ev) {
        var a = ev.target.closest ? ev.target.closest('a.fv-crumb') : null;
        if (!a) return;
        ev.preventDefault();
        loadDir(a.getAttribute('data-path') || '');
    }

    function syncListChecks() {
        var rows = _listEl.querySelectorAll('.fv-item');
        for (var i = 0; i < rows.length; i++) {
            var p = rows[i].getAttribute('data-path');
            var cb = rows[i].querySelector('.fv-rowcb');
            if (cb) cb.checked = !!_selected[p];
            rows[i].classList.toggle('selected', !!_selected[p]);
        }
    }

    function selectedPaths() { return Object.keys(_selected); }
    function selCount() { return selectedPaths().length; }

    function singleSelectedFile() {
        var p = selectedPaths();
        if (p.length !== 1) return false;
        var row = findRow(p[0]);
        return !!row && row.getAttribute('data-dir') === '0';
    }
    function onlyArchivesSelected() {
        var p = selectedPaths();
        if (!p.length) return false;
        for (var i = 0; i < p.length; i++) {
            var e = null;
            for (var k = 0; k < _lastEntries.length; k++) if (_lastEntries[k].path === p[i]) { e = _lastEntries[k]; break; }
            if (!e || e.is_dir || e.category !== 'arch') return false;
        }
        return true;
    }
    function singleSelectedFolder() {
        var p = selectedPaths();
        if (p.length !== 1) return '';
        var row = findRow(p[0]);
        return (row && row.getAttribute('data-dir') === '1') ? p[0] : '';
    }

    function updateOps() {
        var n = selCount();
        var hasPv = !!(_previewFile && _previewFile.path);
        var w = _editMode;
        if (_dlBtn)     _dlBtn.disabled     = !(hasPv || n >= 1);
        if (_pathBtn)   _pathBtn.disabled   = !pathForCopy();
        if (_locateBtn) _locateBtn.disabled = !locatePath();
        if (_searchBtn) _searchBtn.disabled = !_inFolder;
        if (_hashBtn)   _hashBtn.disabled   = !focusedFile();
        if (_rawBtn)    _rawBtn.disabled    = !(_rawOk || singleSelectedFile());
        if (_renameBtn) _renameBtn.disabled = !(w && n === 1);
        if (_deleteBtn) _deleteBtn.disabled = !(w && n >= 1);
        if (_ownerBtn)  _ownerBtn.disabled  = !(w && n >= 1);
        if (_permBtn)   _permBtn.disabled   = !(w && n >= 1);
        if (_copyBtn)   _copyBtn.disabled   = !(w && n >= 1);
        if (_moveBtn)   _moveBtn.disabled   = !(w && n >= 1);
        var onlyArch = w && n >= 1 && onlyArchivesSelected();
        if (_compressBtn) _compressBtn.disabled = !(w && n >= 1) || onlyArch;
        var add = w && _inFolder;
        if (_createBtn) _createBtn.disabled = !add;
        if (_uploadBtn) _uploadBtn.disabled = !add;
        if (_recycleBtn) _recycleBtn.disabled = !w;
        if (_spaceBtn) _spaceBtn.disabled = !_inFolder;

        var eye  = T('Turn on editing with the eye icon at the top right');
        var need = !w ? eye : (n === 0 ? T('Tick the files you want this to act on') : '');
        whyOff(_renameBtn, T('Rename'), w && n > 1 ? T('Rename works on one file at a time') : need);
        whyOff(_deleteBtn, T('Delete'), need);
        whyOff(_ownerBtn,  T('Change owner'), need);
        whyOff(_permBtn,   T('Change permissions'), need);
        whyOff(_copyBtn,   T('Copy'), need);
        whyOff(_moveBtn,   T('Move'), need);
        whyOff(_compressBtn, T('Compress'), onlyArch ? (n === 1 ? T('This is already an archive') : T('These are already archives')) : need);
        whyOff(_createBtn, T('Create'), !w ? eye : (!_inFolder ? T('Open a folder first') : ''));
        whyOff(_uploadBtn, T('Upload'), !w ? eye : (!_inFolder ? T('Open a folder first') : ''));
        whyOff(_recycleBtn, T('Recycle Bin'), !w ? eye : '');
        whyOff(_dlBtn, T('Download'), T('Open a file, or tick the items to download'));
        whyOff(_pathBtn, T('Copy the path to the clipboard'), T('Open a folder first'));
        whyOff(_locateBtn, T('Which disk holds this'), T('Open a folder on a disk, a pool or a share first'));
        whyOff(_searchBtn, singleSelectedFolder() ? T('Search below the ticked folder') : T('Search below this folder'), T('Open a folder first'));
        whyOff(_hashBtn, T('Checksum of the open or ticked file'), T('Open or tick a file first'));
        whyOff(_rawBtn, T('Open the file in a new tab'), T('Open or tick a file first'));
        whyOff(_wrapBtn, T('Toggle line wrapping'), T('Open a text file first'));
        whyOff(_spaceBtn, singleSelectedFolder() ? T('Analyse the space of the ticked folder') : T('Analyse folder space'), T('Open a folder first'));
    }

    function whyOff(btn, label, reason) {
        if (!btn) return;
        btn.title = (btn.disabled && reason) ? reason : label;
    }

    function setMode(edit) {
        _editMode = !!edit;
        if (_rootEl) _rootEl.classList.toggle('fv-edit', _editMode);
        var mb = document.getElementById('fv-mode');
        if (mb) {
            var ic = mb.querySelector('i');
            if (ic) ic.className = 'fa fa-fw ' + (_editMode ? 'fa-pencil' : 'fa-eye');
            mb.title = _editMode ? T('Editing on - click for preview only') : T('Preview only - click to allow editing');
        }
        _selected = {};
        if (_listEl) {
            var cbs = _listEl.querySelectorAll('.fv-rowcb');
            for (var i = 0; i < cbs.length; i++) cbs[i].checked = false;
        }
        if (!_previewFile) showFolderOverview();
        updateSelUi();
        refreshEditBtn();
        refreshExtractBtn();
    }

    function syncTableChecks() {
        if (!_bodyEl) return;
        var rows = _bodyEl.querySelectorAll('.fv-fo__row[data-path]');
        var total = 0, n = 0;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].classList.contains('fv-fo__row--up')) continue;
            var on = !!_selected[rows[i].getAttribute('data-path')];
            var cb = rows[i].querySelector('.fv-focb');
            if (cb) { cb.checked = on; total++; if (on) n++; }
            rows[i].classList.toggle('selected', on);
        }
        var all = document.getElementById('fv-fo-all');
        if (all) { all.checked = (n > 0 && n === total); all.indeterminate = (n > 0 && n < total); }
    }

    function updateSelUi() {
        var rows = _listEl.querySelectorAll('.fv-item');
        for (var i = 0; i < rows.length; i++) {
            rows[i].classList.toggle('selected', !!_selected[rows[i].getAttribute('data-path')]);
        }
        syncTableChecks();
        updateOps();
    }

    function onListChange(ev) {
        var t = ev.target;
        if (!t) return;
        if (t.classList && t.classList.contains('fv-rowcb')) {
            var row = t.closest('.fv-item');
            if (!row) return;
            var p = row.getAttribute('data-path');
            if (t.checked) _selected[p] = true; else delete _selected[p];
            updateSelUi();
        }
    }

    var _modal = null;

    var _modalOnClose = null;

    function modalClose() {
        if (_modal && _modal.parentNode) _modal.parentNode.removeChild(_modal);
        _modal = null;
        document.removeEventListener('keydown', modalKey, true);
        var cb = _modalOnClose;
        _modalOnClose = null;
        if (cb) cb();
    }
    function modalKey(e) {
        if (!_modal) return;
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); modalClose(); return; }
        if (e.key === 'Enter') {
            if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
            var ok = _modal.querySelector('.fv-modal__ok');
            if (ok && !ok.disabled) { e.preventDefault(); ok.click(); }
        }
    }
    function modalOpen(title, inner, okLabel, okClass, onOk, okOnly) {
        modalClose();
        var ov = document.createElement('div');
        ov.className = 'fv-modal' + (_cfg.lightTheme ? ' fv-light' : '') +
                       (_cfg.theme ? ' fv-theme-' + _cfg.theme : '');
        if (_cfg.lang) ov.lang = _cfg.lang;
        ov.innerHTML =
            '<div class="fv-modal__panel" role="dialog" aria-modal="true">' +
              '<div class="fv-modal__head">' + esc(title) + '</div>' +
              '<div class="fv-modal__body">' + inner + '</div>' +
              '<div class="fv-modal__foot">' +
                (okOnly ? '' : '<button type="button" class="fv-btn fv-modal__cancel">' + T('Cancel') + '</button>') +
                '<button type="button" class="fv-btn ' + (okClass || 'fv-btn--primary') + ' fv-modal__ok">' + esc(okLabel || 'OK') + '</button>' +
              '</div>' +
            '</div>';
        ov.addEventListener('mousedown', function (e) { if (e.target === ov) modalClose(); });
        var cancel = ov.querySelector('.fv-modal__cancel');
        if (cancel) cancel.addEventListener('click', modalClose);
        ov.querySelector('.fv-modal__ok').addEventListener('click', function () { onOk(ov); });
        document.body.appendChild(ov);
        _modal = ov;
        document.addEventListener('keydown', modalKey, true);
        return ov;
    }
    function noteModal(title, html) {
        modalOpen(title, html, T('Close'), 'fv-btn--primary', function () { modalClose(); }, true);
    }
    function modalError(ov, msg) {
        var e = ov.querySelector('.fv-modal__err');
        if (e) { e.textContent = msg || ''; e.style.display = msg ? '' : 'none'; }
    }
    function modalBusy(ov, on) {
        var ok = ov.querySelector('.fv-modal__ok');
        if (ok) ok.disabled = !!on;
    }

    var _favs    = [];
    var _favOpen = false;

    function favTarget() {
        return (_previewFile && _previewFile.path) ? _previewFile.path : _currentPath;
    }

    function favHas(path) {
        for (var i = 0; i < _favs.length; i++) if (_favs[i].path === path) return true;
        return false;
    }

    function refreshStar() {
        if (!_starEl) return;
        var t = favTarget();
        var on = !!t && favHas(t);
        _starEl.disabled = !t;
        _starEl.setAttribute('aria-pressed', on ? 'true' : 'false');
        _starEl.title = !t ? T('Favourites')
                           : (on ? T('Remove from favourites') : T('Add to favourites'));
    }

    function favLoad() {
        return fetchJson('fav_list', '').then(function (d) {
            if (d && d.ok) { _favs = d.entries || []; refreshStar(); }
        }).catch(function () {});
    }

    function favToggle() {
        var t = favTarget();
        if (!t) return;
        postJson('fav_toggle', { path: t }).then(function (d) {
            if (!d || !d.ok) { noteModal(T('Favourites'), esc((d && d.error) || T('could not save'))); return; }
            _favs = d.entries || [];
            refreshStar();
            if (_favOpen) favRender();
        });
    }

    function favRender() {
        if (!_favMenuEl) return;
        if (!_favs.length) {
            _favMenuEl.innerHTML = '<div class="fv-fav-empty">' + T('No favourites yet') + '</div>';
            return;
        }
        var h = '';
        for (var i = 0; i < _favs.length; i++) {
            var f = _favs[i];
            h += '<button type="button" class="fv-fav-item" role="menuitem" data-path="' + esc(f.path) + '"' +
                 ' title="' + esc(f.path) + '">' +
                 '<span class="fv-fav-item__ico">' + (f.is_dir ? FOLDER_SVG : FILE_SVG) + '</span>' +
                 '<span class="fv-fav-item__name">' + esc(f.name) + '</span></button>';
        }
        _favMenuEl.innerHTML = h;
    }

    function favMenuClose() {
        _favOpen = false;
        if (_favMenuEl) _favMenuEl.hidden = true;
        if (_favBtn) _favBtn.setAttribute('aria-expanded', 'false');
    }

    function favMenuToggle() {
        if (_favOpen) { favMenuClose(); return; }
        favLoad().then(function () {
            favRender();
            _favOpen = true;
            if (_favMenuEl) _favMenuEl.hidden = false;
            if (_favBtn) _favBtn.setAttribute('aria-expanded', 'true');
        });
    }

    function favGo(path) {
        favMenuClose();
        var f = null;
        for (var i = 0; i < _favs.length; i++) if (_favs[i].path === path) f = _favs[i];
        if (!f) return;
        if (f.is_dir) { loadDir(path); return; }

        var parent = path.replace(/\/[^/]+$/, '');
        loadDir(parent).then(function () {
            var row = findRow(path);
            if (row) openFile(row);
        });
    }

    function baseName(p) {
        var s = String(p || '').replace(/\/+$/, '');
        var i = s.lastIndexOf('/');
        return i >= 0 ? s.slice(i + 1) : s;
    }
    function findRow(path) {
        var items = _listEl.querySelectorAll('.fv-item');
        for (var i = 0; i < items.length; i++) {
            if (items[i].getAttribute('data-path') === path) return items[i];
        }
        return null;
    }
    function opMsg(label, d) { return (d && d.error) ? (label + ': ' + d.error) : tf('%s failed.', label); }

    function refreshRows(paths) {
        if (!_currentPath || !paths || !paths.length) return;
        var want = {};
        for (var i = 0; i < paths.length; i++) want[paths[i]] = true;

        fetchJson('list', 'path=' + encodeURIComponent(_currentPath)).then(function (d) {
            if (!d || !d.ok) return;
            var entries = d.entries || [];
            for (var j = 0; j < entries.length; j++) {
                var e = entries[j];
                if (!want[e.path]) continue;
                var row = findRow(e.path);
                var sub = row ? row.querySelector('.fv-item__sub') : null;
                if (sub) sub.innerHTML = itemSub(e);
                for (var k = 0; k < _lastEntries.length; k++) {
                    if (_lastEntries[k].path === e.path) { _lastEntries[k] = e; break; }
                }
                var tr = _bodyEl ? _bodyEl.querySelector('.fv-fo__row[data-path="' + cssEsc(e.path) + '"]') : null;
                if (tr) tr.outerHTML = foRowHtml(e, _editMode);
            }
        }).catch(function () {});
    }

    function refreshAfter(selectPath) {
        return loadDir(_currentPath).then(function () {
            if (!selectPath) return;
            var row = findRow(selectPath);
            if (row) { row.classList.add('active'); if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' }); }
        });
    }

    function promptCreate() {
        if (!_currentPath) return;
        var inner =
            '<label class="fv-field"><span>' + T('Name') + '</span>' +
              '<input type="text" class="fv-input" id="fv-new-name" autocomplete="off" spellcheck="false" placeholder="new-file.txt"></label>' +
            '<div class="fv-radio">' +
              '<label><input type="radio" name="fv-kind" value="file" checked> ' + T('File') + '</label>' +
              '<label><input type="radio" name="fv-kind" value="dir"> ' + T('Folder') + '</label>' +
            '</div>' +
            '<div class="fv-modal__err" style="display:none"></div>';
        var ov = modalOpen(T('Create in this folder'), inner, T('Create'), 'fv-btn--primary', function (ov) {
            var name = (ov.querySelector('#fv-new-name').value || '').trim();
            var kind = ov.querySelector('input[name="fv-kind"]:checked').value;
            if (!name) { modalError(ov, T('Enter a name.')); return; }
            modalBusy(ov, true);
            postJson('create', { parent: _currentPath, name: name, kind: kind }).then(function (d) {
                if (!d || !d.ok) { modalBusy(ov, false); modalError(ov, opMsg(T('Create'), d)); return; }
                modalClose();
                refreshAfter(d.path);
            });
        });
        ov.querySelector('#fv-new-name').focus();
    }

    function promptRename() {
        var paths = selectedPaths();
        if (paths.length !== 1) return;
        var target = paths[0], cur = baseName(target);
        var inner =
            '<label class="fv-field"><span>' + T('New name') + '</span>' +
              '<input type="text" class="fv-input" id="fv-rn-name" autocomplete="off" spellcheck="false"></label>' +
            '<div class="fv-modal__err" style="display:none"></div>';
        var ov = modalOpen(T('Rename'), inner, T('Rename'), 'fv-btn--primary', function (ov) {
            var name = (ov.querySelector('#fv-rn-name').value || '').trim();
            if (!name) { modalError(ov, T('Enter a name.')); return; }
            if (name === cur) { modalClose(); return; }
            modalBusy(ov, true);
            postJson('rename', { path: target, name: name }).then(function (d) {
                if (!d || !d.ok) { modalBusy(ov, false); modalError(ov, opMsg(T('Rename'), d)); return; }
                modalClose();
                refreshAfter(d.path);
            });
        });
        var inp = ov.querySelector('#fv-rn-name');
        inp.value = cur;
        var dot = cur.lastIndexOf('.');
        inp.focus();
        if (dot > 0) inp.setSelectionRange(0, dot); else inp.select();
    }

    function promptDelete() {
        var paths = selectedPaths();
        if (!paths.length) return;
        var noBin = paths[0].split('/').filter(Boolean).length < 4;
        var what  = paths.length === 1 ? '<b>' + esc(baseName(paths[0])) + '</b>' : '<b>' + tf('%s items', paths.length) + '</b>';
        var inner =
            '<p class="fv-confirm">' + (_recycleOn && !noBin
                ? tf('Move %s to the Recycle Bin?', what)
                : tf('Permanently delete %s? This cannot be undone.', what) +
                  (_recycleOn ? ' ' + T('The recycle bin lives inside each share, and there is none at this level.') : '')) +
            '</p>' +
            '<div class="fv-modal__err" style="display:none"></div>';
        modalOpen(T('Delete'), inner, T('Delete'), 'fv-btn--danger', function (ov) {
            modalBusy(ov, true);
            postJson('delete', { paths: JSON.stringify(paths) }).then(function (d) {
                modalClose();
                clearPreview();
                refreshAfter(null).then(function () {
                    var failed = (d && d.failed) || [];
                    if (!d || !d.ok) {
                        noteModal(T('Delete'), '<p class="fv-confirm">' + esc((d && d.error) || T('Delete failed.')) + '</p>');
                    } else if (failed.length) {
                        noteModal(T('Delete'), '<p class="fv-confirm">' + T('Some items were not deleted:') + '</p>' +
                            '<p class="fv-confirm" style="color:var(--fv-warn-text)">' + failed.map(esc).join('<br>') + '</p>');
                    }
                });
            });
        });
    }

    var UPLOAD_CHUNK = 1024 * 1024;
    var UPLOAD_PARALLEL = 4;

    function uid12() {
        var c = '0123456789abcdefghijklmnopqrstuvwxyz', s = '';
        for (var i = 0; i < 12; i++) s += c[Math.floor(Math.random() * 36)];
        return s;
    }

    var _uploadMode = false;
    var _upQueue = [];
    var _upActive = null;

    function resetUpload() {
        if (_upActive) { _upActive.kill(); _upActive = null; }
        _uploadMode = false; _upQueue = [];
    }

    function upLabelHtml(it) {
        return (it.subpath ? '<i>' + esc(it.subpath) + '/</i>' : '') + esc(it.name);
    }

    function enterUploadMode() {
        if (!_currentPath) return;
        leaveEditOk(function () { enterUploadModeNow(); });
    }

    function enterUploadModeNow() {
        resetPaneModes();
        _uploadMode = true;
        if (_pvEl) _pvEl.classList.add('fv-preview--active');
        renderPathCrumbs(null);
        _selectedFile = null; _previewFile = null;
        markActive(null);
        if (_pvToolsEl) _pvToolsEl.innerHTML = '';
        setFileTools(false, false);
        renderUploadIdle();
    }

    function renderUploadIdle() {
        _bodyEl.innerHTML =
            '<div class="fv-uppanel">' +
              '<div class="fv-uppanel__title">' + tf('Upload to %s', '<span>' + esc(baseName(_currentPath || '/')) + '</span>') + '</div>' +
              '<div class="fv-up2-drop" id="fv-up-drop">' +
                '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 13v8"/><path d="M8 17l4-4 4 4"/><path d="M20 16.6A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 14.9"/></svg>' +
                '<p>' + T('Drop files or a folder here') + '</p>' +
                '<div class="fv-up2-pickers">' +
                  '<button type="button" class="fv-btn" id="fv-up-pick">' + T('Choose files') + '</button>' +
                  '<button type="button" class="fv-btn" id="fv-up-pickdir">' + T('Choose folder') + '</button>' +
                '</div>' +
                '<input type="file" id="fv-up-input" multiple style="display:none">' +
                '<input type="file" id="fv-up-inputdir" webkitdirectory style="display:none">' +
              '</div>' +
              '<div class="fv-up2-list" id="fv-up-list"></div>' +
              '<label class="fv-check"><input type="checkbox" id="fv-up-over"> ' + T('Overwrite files with the same name') + '</label>' +
              '<div class="fv-up2-actions">' +
                '<button type="button" class="fv-btn" id="fv-up-cancel">' + T('Cancel') + '</button>' +
                '<button type="button" class="fv-btn fv-btn--primary" id="fv-up-go" disabled>' + T('Upload') + '</button>' +
              '</div>' +
            '</div>';

        var list = _bodyEl.querySelector('#fv-up-list');
        var go   = _bodyEl.querySelector('#fv-up-go');

        function renderQueue() {
            list.innerHTML = _upQueue.map(function (it, i) {
                return '<div class="fv-up2-row">' +
                         '<button type="button" class="fv-up2-del" data-i="' + i + '" title="' + T('Remove') + '" aria-label="' + T('Remove') + '">\u00d7</button>' +
                         '<span class="fv-up2-name">' + upLabelHtml(it) + '</span>' +
                         '<span class="fv-up2-size">' + fmtBytes(it.file.size) + '</span>' +
                       '</div>';
            }).join('');
            go.disabled = !_upQueue.length;
            go.textContent = _upQueue.length ? (_upQueue.length === 1 ? tf('Upload %s file', 1) : tf('Upload %s files', _upQueue.length)) : T('Upload');
        }
        function pushPlain(fileList) {
            for (var i = 0; i < fileList.length; i++) _upQueue.push({ file: fileList[i], name: fileList[i].name, subpath: '' });
            renderQueue();
        }
        function pushFolder(fileList) {
            for (var i = 0; i < fileList.length; i++) {
                var f = fileList[i];
                var rp = (f.webkitRelativePath || f.name).split('/');
                var nm = rp.pop();
                _upQueue.push({ file: f, name: nm, subpath: rp.join('/') });
            }
            renderQueue();
        }

        list.addEventListener('click', function (e) {
            var b = e.target;
            if (!b.classList || !b.classList.contains('fv-up2-del')) return;
            var i = parseInt(b.getAttribute('data-i'), 10);
            if (i >= 0 && i < _upQueue.length) { _upQueue.splice(i, 1); renderQueue(); }
        });
        _bodyEl.querySelector('#fv-up-pick').addEventListener('click', function () { _bodyEl.querySelector('#fv-up-input').click(); });
        _bodyEl.querySelector('#fv-up-pickdir').addEventListener('click', function () { _bodyEl.querySelector('#fv-up-inputdir').click(); });
        _bodyEl.querySelector('#fv-up-input').addEventListener('change', function (e) { pushPlain(e.target.files); e.target.value = ''; });
        _bodyEl.querySelector('#fv-up-inputdir').addEventListener('change', function (e) { pushFolder(e.target.files); e.target.value = ''; });
        _bodyEl.querySelector('#fv-up-cancel').addEventListener('click', function () { clearPreview(); });
        go.addEventListener('click', function () {
            if (!_upQueue.length) return;
            var conflict = _bodyEl.querySelector('#fv-up-over').checked ? 'overwrite' : 'rename';
            startPanelUpload(_upQueue.slice(), conflict);
        });

        var drop = _bodyEl.querySelector('#fv-up-drop');
        ['dragover', 'dragenter'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('fv-up2-drop--on'); }); });
        ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('fv-up2-drop--on'); }); });
        drop.addEventListener('drop', function (e) {
            var dt = e.dataTransfer; if (!dt) return;
            var its = dt.items;
            if (its && its.length && its[0] && its[0].webkitGetAsEntry) {
                var entries = [];
                for (var i = 0; i < its.length; i++) { var en = its[i].webkitGetAsEntry(); if (en) entries.push(en); }
                var pending = entries.length, out = [];
                if (!pending) return;
                entries.forEach(function (en) {
                    walkEntry(en, '', out, function () {
                        if (--pending === 0) { out.forEach(function (it) { _upQueue.push(it); }); renderQueue(); }
                    });
                });
            } else if (dt.files) {
                pushPlain(dt.files);
            }
        });

        renderQueue();
    }

    function walkEntry(entry, prefix, out, after) {
        if (entry.isFile) {
            entry.file(function (f) { out.push({ file: f, name: f.name, subpath: prefix }); after(); }, after);
        } else if (entry.isDirectory) {
            var here = prefix ? prefix + '/' + entry.name : entry.name;
            var reader = entry.createReader(), all = [];
            (function readMore() {
                reader.readEntries(function (ents) {
                    if (!ents.length) {
                        var i = 0;
                        (function next() { if (i >= all.length) { after(); return; } walkEntry(all[i++], here, out, next); })();
                    } else { all = all.concat(Array.prototype.slice.call(ents)); readMore(); }
                }, after);
            })();
        } else { after(); }
    }

    function startPanelUpload(items, conflict) {
        var total = items.length, totalBytes = 0;
        items.forEach(function (it) { totalBytes += it.file.size; });
        var qi = 0, done = 0, completedBytes = 0, failed = [], cancelled = false, finished = false, killed = false;
        var workers = Math.min(UPLOAD_PARALLEL, total) || 1;
        var activeWorkers = workers;
        var live = {};
        var controls = {};

        _upActive = { kill: function () { killed = true; cancelled = true; for (var k in controls) { if (controls[k] && controls[k].abort) controls[k].abort(); } } };

        _bodyEl.innerHTML =
            '<div class="fv-uppanel">' +
              '<div class="fv-up2-overall"><span id="fv-up-done"></span><span class="sub" id="fv-up-bytes"></span></div>' +
              '<div class="fv-up2-slots" id="fv-up-slots"></div>' +
              '<div class="fv-up2-actions"><button type="button" class="fv-btn fv-btn--danger" id="fv-up-stop">' + T('Cancel') + '</button></div>' +
            '</div>';
        var slotsEl = _bodyEl.querySelector('#fv-up-slots');
        var doneEl  = _bodyEl.querySelector('#fv-up-done');
        var bytesEl = _bodyEl.querySelector('#fv-up-bytes');
        var stopBtn = _bodyEl.querySelector('#fv-up-stop');

        stopBtn.addEventListener('click', function () {
            if (finished) { clearPreview(); return; }
            cancelled = true; stopBtn.disabled = true; stopBtn.textContent = T('Cancelling') + '\u2026';
            for (var k in controls) { if (controls[k] && controls[k].abort) controls[k].abort(); }
        });

        function renderOverall() {
            if (killed) return;
            var sent = completedBytes; for (var k in live) sent += live[k];
            if (sent > totalBytes) sent = totalBytes;
            doneEl.innerHTML = (total === 1 ? tf('%s of %s file done', '<b>' + done + '</b>', total) : tf('%s of %s files done', '<b>' + done + '</b>', total));
            bytesEl.textContent = tf('%s of %s', fmtBytes(sent), fmtBytes(totalBytes)) + ' \u00b7 ' + tf('%s at once', workers);
        }
        function makeSlot() {
            var el = document.createElement('div');
            el.className = 'fv-up2-item';
            el.innerHTML = '<div class="fv-up2-item__top"><span class="fv-up2-item__name"></span><span class="fv-up2-item__pct">0%</span></div>' +
                           '<div class="fv-up2-bar"><div class="fv-up2-fill"></div></div>';
            slotsEl.appendChild(el);
            return { el: el, name: el.querySelector('.fv-up2-item__name'), pct: el.querySelector('.fv-up2-item__pct'), fill: el.querySelector('.fv-up2-fill') };
        }
        function finish() {
            if (finished || killed) return; finished = true; _upActive = null;
            loadDir(_currentPath);
            var okN = total - failed.length;
            var msg = cancelled ? (T('Upload cancelled') + (done ? (' \u2014 ' + tf('%s of %s uploaded', okN, total)) : '') + '.')
                    : (failed.length === total ? T('Upload failed.') : (T('Done') + ' \u2014 ' + tf('%s of %s uploaded', okN, total) + '.'));
            var extra = failed.length ? '<div class="fv-up2-failed">' + T('Failed:') + '<br>' + failed.map(esc).join('<br>') + '</div>' : '';
            _bodyEl.innerHTML =
                '<div class="fv-uppanel">' +
                  '<div class="fv-up2-msg">' + esc(msg) + '</div>' + extra +
                  '<div class="fv-up2-actions"><button type="button" class="fv-btn fv-btn--primary" id="fv-up-close">' + T('Close') + '</button></div>' +
                '</div>';
            var cb = _bodyEl.querySelector('#fv-up-close');
            if (cb) cb.addEventListener('click', function () { clearPreview(); });
        }
        function runWorker(slot, wid) {
            if (cancelled || qi >= items.length) {
                if (slot.el.parentNode) slot.el.parentNode.removeChild(slot.el);
                delete live[wid];
                activeWorkers--;
                if (activeWorkers <= 0) finish();
                return;
            }
            var it = items[qi++];
            slot.name.innerHTML = upLabelHtml(it);
            slot.pct.textContent = '0%'; slot.fill.style.width = '0%';
            live[wid] = 0;
            var control = {}; controls[wid] = control;
            sendOneFile(it, conflict, control,
                function (offset) {
                    live[wid] = offset;
                    var p = it.file.size ? Math.round(offset / it.file.size * 100) : 100;
                    slot.pct.textContent = p + '%'; slot.fill.style.width = p + '%';
                    renderOverall();
                },
                function (ok, err) {
                    done++; completedBytes += it.file.size; live[wid] = 0; delete controls[wid];
                    if (!ok && !cancelled) failed.push((it.subpath ? it.subpath + '/' : '') + it.name + (err ? ' - ' + err : ''));
                    renderOverall();
                    runWorker(slot, wid);
                });
        }

        renderOverall();
        for (var w = 0; w < workers; w++) runWorker(makeSlot(), w);
    }

    function sendOneFile(it, conflict, control, onProg, onDone) {
        var file = it.file, offset = 0, aborter = null, stopped = false;
        var uid = uid12();
        control.abort = function () { stopped = true; if (aborter) aborter.abort(); };

        function step() {
            var end = Math.min(offset + UPLOAD_CHUNK, file.size);
            var last = end >= file.size;
            var reader = new FileReader();
            reader.onerror = function () { if (!stopped) onDone(false, T('read error')); };
            reader.onloadend = function (e) {
                if (stopped) return;
                if (!e.target || e.target.readyState !== FileReader.DONE) return;
                var b64; try { b64 = btoa(e.target.result); } catch (err) { onDone(false, T('encode error')); return; }
                var body = 'csrf_token=' + encodeURIComponent(csrfToken()) +
                           '&uid=' + encodeURIComponent(uid) +
                           '&dest=' + encodeURIComponent(_currentPath) +
                           '&subpath=' + encodeURIComponent(it.subpath || '') +
                           '&name=' + encodeURIComponent(it.name) +
                           '&offset=' + offset +
                           '&total=' + file.size +
                           '&conflict=' + encodeURIComponent(conflict) +
                           (last ? '&last=1' : '') +
                           '&data=' + encodeURIComponent(b64);
                aborter = (typeof AbortController !== 'undefined') ? new AbortController() : null;
                fetch(apiUrl('upload', ''), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-TOKEN': csrfToken() },
                    credentials: 'same-origin',
                    body: body,
                    signal: aborter ? aborter.signal : undefined
                }).then(function (r) {
                    return r.text().then(function (t) {
                        try { return JSON.parse(t); }
                        catch (e2) { return { ok: false, error: (t && t.trim()) ? ('server: ' + t.replace(/\s+/g, ' ').slice(0, 140)) : ('HTTP ' + r.status) }; }
                    });
                }).then(function (d) {
                    if (!d || !d.ok) { onDone(false, (d && d.error) || 'failed'); return; }
                    offset = end; onProg(offset);
                    if (last) onDone(true); else step();
                }).catch(function (e) {
                    onDone(false, (e && e.name === 'AbortError') ? T('cancelled') : T('network error'));
                });
            };
            reader.readAsBinaryString(file.slice(offset, end));
        }
        step();
    }

    var _spaceMode = false;
    var _spJobId = '';
    var _spTimer = null;
    var _spPath = '';
    var _spCancelling = false;

    function resetSpace() {
        if (_spTimer) { clearInterval(_spTimer); _spTimer = null; }
        if (_spaceMode && _spJobId) { postJson('job_cancel', { id: _spJobId }); spClearJob(); }
        _spaceMode = false; _spJobId = ''; _spCancelling = false;
    }

    function resetPaneModes() { resetUpload(); resetRecycle(); resetSpace(); resetSearch(); }

    function enterSpaceMode() {
        var target = singleSelectedFolder() || _currentPath;
        if (!target) return;
        leaveEditOk(function () { startSpaceScan(target, true); });
    }

    function startSpaceScan(path, takeover) {
        resetPaneModes();
        _spaceMode = true;
        _spPath = path;
        _spCancelling = false;
        if (_pvEl) _pvEl.classList.add('fv-preview--active');
        if (takeover) {
            renderPathCrumbs(null);
            _selectedFile = null; _previewFile = null;
            markActive(null);
            if (_pvToolsEl) _pvToolsEl.innerHTML = '';
            setFileTools(false, false);
        }
        _bodyEl.innerHTML = '<div class="fv-sppanel">' + spHead('') + '<div class="fv-sp-line">' + T('Starting the scan') + '\u2026</div></div>';
        postJson('space_start', { path: path }).then(function (d) {
            if (!_spaceMode) return;
            if (!d || !d.ok) { renderSpaceError((d && d.error) || 'failed'); return; }
            _spJobId = d.id;
            spSaveJob(d.id, path);
            _spTimer = setInterval(pollSpace, 500);
            pollSpace();
        });
    }

    function pollSpace() {
        if (!_spaceMode || !_spJobId) return;
        fetchJson('job_status', 'id=' + encodeURIComponent(_spJobId)).then(function (d) {
            if (!_spaceMode || !_spJobId) return;
            var st = d && d.status;
            if (!d || !d.ok || !st) { stopSpacePoll(); renderSpaceError((d && d.error) || T('job lost')); return; }
            if (st.state === 'running' || st.state === 'queued') { renderSpaceProgress(st); return; }
            stopSpacePoll();
            if (st.state === 'done') renderSpaceResult(st);
            else if (st.state === 'cancelled') renderSpaceCancelled();
            else renderSpaceError(st.message || T('scan failed'));
        }).catch(function () {});
    }

    function stopSpacePoll() {
        if (_spTimer) { clearInterval(_spTimer); _spTimer = null; }
        _spJobId = '';
        spClearJob();
    }

    function spHead(btnHtml) {
        return '<div class="fv-sp-top"><div class="fv-sp-title">' + T('Space usage') + ' <span>\u00b7 ' + esc(baseName(_spPath || '/')) + '</span></div>' + btnHtml + '</div>';
    }

    function spResume() {
        var j = spReadJob();
        if (!j) return;
        fetchJson('job_status', 'id=' + encodeURIComponent(j.id)).then(function (d) {
            var st = d && d.ok && d.status;
            if (!st || (st.state !== 'running' && st.state !== 'queued' && st.state !== 'done')) { spClearJob(); return; }

            resetPaneModes();
            _spaceMode = true;
            _spPath = j.path || '';
            _spCancelling = false;
            if (_pvEl) _pvEl.classList.add('fv-preview--active');
            renderPathCrumbs(null);
            if (_pvToolsEl) _pvToolsEl.innerHTML = '';
            setFileTools(false, false);

            if (st.state === 'done') { spClearJob(); renderSpaceResult(st); return; }
            _spJobId = j.id;
            _spTimer = setInterval(pollSpace, 500);
            renderSpaceProgress(st);
        }).catch(function () { spClearJob(); });
    }

    function spBindRescan() {
        var rb = _bodyEl.querySelector('#fv-sp-rescan');
        if (rb) rb.addEventListener('click', function () { startSpaceScan(_spPath, false); });
    }

    function renderSpaceProgress(st) {
        var tot = st.children_total || 0, done = st.children_done || 0;
        var pct = tot > 0 ? Math.min(100, Math.round(done / tot * 100)) : 0;
        var line = T('Scanning') + '\u2026 ' + tf('%s of %s items', done, tot) + ' \u00b7 ' +
                   tf('%s so far', fmtBytes(st.bytes || 0)) + ' \u00b7 ' + tf('%s files', (st.files || 0).toLocaleString()) +
                   (st.current ? ' \u00b7 ' + tf('current: %s', esc(st.current)) : '');
        _bodyEl.innerHTML = '<div class="fv-sppanel">' +
            spHead('<button type="button" class="fv-btn fv-btn--danger" id="fv-sp-cancel"' + (_spCancelling ? ' disabled' : '') + '>' + (_spCancelling ? T('Cancelling') + '\u2026' : T('Cancel')) + '</button>') +
            '<div class="fv-sp-bar"><div class="fv-sp-fill" style="width:' + pct + '%"></div></div>' +
            '<div class="fv-sp-line">' + line + '</div></div>';
        var cb = _bodyEl.querySelector('#fv-sp-cancel');
        if (cb) cb.addEventListener('click', function () {
            _spCancelling = true;
            cb.disabled = true; cb.textContent = T('Cancelling') + '\u2026';
            if (_spJobId) postJson('job_cancel', { id: _spJobId });
        });
    }

    function renderSpaceResult(st) {
        var kids = st.children || [];
        var total = st.bytes || 0;
        var max = 0;
        kids.forEach(function (c) { if ((c.bytes || 0) > max) max = c.bytes; });

        var html = '<div class="fv-sppanel">' +
            spHead('<button type="button" class="fv-btn" id="fv-sp-rescan">' + T('Rescan') + '</button>') +
            '<div class="fv-sp-note">' + T('Click a folder to open and analyse it. Hard linked files are counted once. Sizes are allocated space on disk.') + '</div>' +
            '<div class="fv-sp-sum">' + tf('%s in %s files', '<b>' + fmtBytes(total) + '</b>', (st.files || 0).toLocaleString()) + ' \u00b7 ' + tf('scanned in %ss', (st.elapsed != null ? st.elapsed : '?')) +
            ((st.skipped || 0) > 0 ? ' \u00b7 <span class="fv-sp-warn">' + tf('%s unreadable', st.skipped) + '</span>' : '') + '</div>';

        if (!kids.length) {
            html += '<div class="fv-sp-line">' + T('This folder is empty.') + '</div>';
        } else {
            html += '<div class="fv-sp-rows">';
            kids.forEach(function (c) {
                var others = (c.name == null);
                var w = max > 0 ? Math.round((c.bytes || 0) / max * 100) : 0;
                var pct = total > 0 ? (c.bytes || 0) / total * 100 : 0;
                var pctTxt = pct >= 1 ? Math.round(pct) + '%' : ((c.bytes || 0) > 0 ? '&lt;1%' : '0%');
                var dim = others || (c.name && c.name.charAt(0) === '.');
                var glyph = others ? '' : (c.is_dir ? RB_FOLDER_SVG : RB_FILE_SVG);
                var label = others ? (T('Others') + ' \u00b7 ' + tf('%s items', c.others)) : esc(c.name);
                html += '<div class="fv-sp-row' + (dim ? ' fv-sp-row--dim' : '') + (!others && c.is_dir ? ' fv-sp-row--dir' : '') + '"' +
                        (!others && c.is_dir ? ' data-dir="' + esc(c.name) + '"' : '') + '>' +
                        (w > 0 ? '<i class="fv-sp-rowfill" style="width:' + w + '%"></i>' : '') +
                        '<span class="fv-sp-glyph">' + glyph + '</span>' +
                        '<span class="fv-sp-name">' + label + '</span>' +
                        '<span class="fv-sp-size">' + fmtBytes(c.bytes || 0) + '</span>' +
                        '<span class="fv-sp-pct">' + pctTxt + '</span>' +
                        '</div>';
            });
            html += '</div>';
        }
        html += '</div>';
        _bodyEl.innerHTML = html;

        spBindRescan();
        _bodyEl.querySelector('.fv-sppanel').addEventListener('click', function (e) {
            var row = e.target && e.target.closest ? e.target.closest('.fv-sp-row--dir') : null;
            if (!row) return;
            var name = row.getAttribute('data-dir');
            if (!name) return;
            var p = _spPath.replace(/\/+$/, '') + '/' + name;
            loadDir(p);
            startSpaceScan(p, false);
        });
    }

    function renderSpaceCancelled() {
        _bodyEl.innerHTML = '<div class="fv-sppanel">' +
            spHead('<button type="button" class="fv-btn" id="fv-sp-rescan">' + T('Rescan') + '</button>') +
            '<div class="fv-sp-line">' + T('Scan cancelled.') + '</div></div>';
        spBindRescan();
    }

    function renderSpaceError(msg) {
        _bodyEl.innerHTML = '<div class="fv-sppanel">' + spHead('') +
            '<div class="fv-sp-line fv-sp-warn">' + esc(msg) + '</div></div>';
    }

    var _searchMode = false;
    var _srRoot = '';
    var _srJobId = '';
    var _srTimer = null;
    var _srLast = null;

    function resetSearch() {
        if (_srTimer) { clearInterval(_srTimer); _srTimer = null; }
        if (_searchMode && _srJobId) postJson('job_cancel', { id: _srJobId });
        _searchMode = false; _srJobId = '';
    }

    function enterSearchMode() {
        var target = singleSelectedFolder() || _currentPath;
        if (!target) return;
        leaveEditOk(function () { enterSearchModeNow(target); });
    }

    function enterSearchModeNow(root) {
        resetPaneModes();
        _searchMode = true;
        _srRoot = root;
        if (_pvEl) _pvEl.classList.add('fv-preview--active');
        renderPathCrumbs(null);
        _selectedFile = null; _previewFile = null;
        markActive(null);
        if (_pvToolsEl) _pvToolsEl.innerHTML = '';
        setFileTools(false, false);
        var last = (_srLast && _srLast.st) ? _srLast : null;
        _bodyEl.innerHTML =
            '<div class="fv-sppanel fv-srpanel">' +
              '<div class="fv-sp-top"><div class="fv-sp-title">' + T('Search') + ' <span>\u00b7 ' + esc(baseName(_srRoot || '/')) + '</span></div></div>' +
              '<form class="fv-sr-form" id="fv-sr-form">' +
                '<input type="text" class="fv-input" id="fv-sr-q" autocomplete="off" spellcheck="false" placeholder="' + T('part of a name, or a pattern like *.mkv') + '" value="' + esc(last ? last.q : '') + '">' +
                '<button type="submit" class="fv-btn fv-btn--primary" id="fv-sr-go">' + T('Search') + '</button>' +
              '</form>' +
              '<div class="fv-sp-note">' + T('Looks through every folder below this one. Case does not matter, and * and ? work as in the shell. Click a result to go to it.') + '</div>' +
              '<div class="fv-sp-line" id="fv-sr-status"></div>' +
              '<div class="fv-sp-rows" id="fv-sr-rows"></div>' +
            '</div>';
        var form = _bodyEl.querySelector('#fv-sr-form');
        form.addEventListener('submit', function (e) { e.preventDefault(); startSearch(); });
        var inp = _bodyEl.querySelector('#fv-sr-q');
        inp.focus();
        if (last) { srPaint(last.st, true, last.path !== _srRoot ? tf('Results from %s.', baseName(last.path)) + ' ' : ''); inp.select(); }
    }

    function startSearch() {
        var inp = _bodyEl.querySelector('#fv-sr-q');
        var q = inp ? inp.value.trim() : '';
        if (!q) { if (inp) inp.focus(); return; }
        if (_srTimer) { clearInterval(_srTimer); _srTimer = null; }
        if (_srJobId) { postJson('job_cancel', { id: _srJobId }); _srJobId = ''; }
        var rows = _bodyEl.querySelector('#fv-sr-rows');
        if (rows) rows.innerHTML = '';
        srStatus(T('Starting') + '\u2026', false);
        var path = _srRoot || _currentPath;
        postJson('search_start', { path: path, q: q }).then(function (d) {
            if (!_searchMode) return;
            if (!d || !d.ok) { srStatus((d && d.error) || T('Could not start.'), false, true); return; }
            _srJobId = d.id;
            _srLast = { path: path, q: q, st: null };
            _srTimer = setInterval(pollSearch, 500);
            pollSearch();
        });
    }

    function pollSearch() {
        if (!_searchMode || !_srJobId) return;
        fetchJson('job_status', 'id=' + encodeURIComponent(_srJobId)).then(function (d) {
            if (!_searchMode || !_srJobId) return;
            var st = d && d.status;
            if (!d || !d.ok || !st) { srStop(); srStatus((d && d.error) || T('job lost'), false, true); return; }
            if (st.state === 'running' || st.state === 'queued') { srPaint(st, false); return; }
            srStop();
            if (st.state === 'done') { if (_srLast) _srLast.st = st; srPaint(st, true); }
            else if (st.state === 'cancelled') srStatus(T('Search cancelled.'), false);
            else srStatus(st.message || T('search failed'), false, true);
        }).catch(function () {});
    }

    function srStop() {
        if (_srTimer) { clearInterval(_srTimer); _srTimer = null; }
        _srJobId = '';
    }

    function srStatus(text, cancel, warn) {
        var el = _bodyEl.querySelector('#fv-sr-status');
        if (!el) return;
        el.className = 'fv-sp-line' + (warn ? ' fv-sp-warn' : '');
        el.innerHTML = esc(text) + (cancel ? ' <button type="button" class="fv-btn fv-btn--danger fv-sr-cancel" id="fv-sr-cancel">' + T('Cancel') + '</button>' : '');
        var cb = el.querySelector('#fv-sr-cancel');
        if (cb) cb.addEventListener('click', function () {
            cb.disabled = true; cb.textContent = T('Cancelling') + '\u2026';
            if (_srJobId) postJson('job_cancel', { id: _srJobId });
        });
    }

    function srPaint(st, done, prefix) {
        if (!st) return;
        var found = st.found || 0, scanned = (st.scanned || 0).toLocaleString();
        if (done) {
            var msg = (prefix || '') + (found === 1 ? T('1 match') : tf('%s matches', found.toLocaleString())) + ' \u00b7 ' + tf('%s entries looked at', scanned) +
                      (st.elapsed != null ? ' \u00b7 ' + tf('%ss', st.elapsed) : '') +
                      (st.capped ? ' \u00b7 ' + tf('only the first %s are shown, narrow the search', found.toLocaleString()) : '') +
                      ((st.skipped || 0) > 0 ? ' \u00b7 ' + tf('%s unreadable', st.skipped) : '');
            srStatus(msg, false, !!st.capped);
        } else {
            srStatus(T('Searching') + '\u2026 ' + tf('%s entries', scanned) + ' \u00b7 ' + tf('%s matches', found) +
                     (st.current ? ' \u00b7 ' + tf('in %s', st.current) : ''), true);
        }
        var box = _bodyEl.querySelector('#fv-sr-rows');
        if (!box) return;
        var list = st.matches || [];
        if (Number(box.getAttribute('data-n')) === list.length && !done) return;
        box.setAttribute('data-n', String(list.length));
        var root = (st.path || _srRoot || _currentPath || '').replace(/\/+$/, '') + '/';
        var html = '';
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            var rel = m.path.indexOf(root) === 0 ? m.path.slice(root.length) : m.path;
            var dir = rel.lastIndexOf('/') >= 0 ? rel.slice(0, rel.lastIndexOf('/')) : '';
            html += '<div class="fv-sp-row fv-sp-row--dir fv-sr-row" data-path="' + esc(m.path) + '" data-dir="' + (m.is_dir ? '1' : '0') + '">' +
                      '<span class="fv-sp-glyph">' + (m.is_dir ? RB_FOLDER_SVG : RB_FILE_SVG) + '</span>' +
                      '<span class="fv-sp-name">' + esc(m.name) + (dir ? '<i class="fv-sr-in">' + esc(dir) + '</i>' : '') + '</span>' +
                      '<span class="fv-sp-size">' + (m.is_dir ? '' : formatBytes(m.size)) + '</span>' +
                      '<span class="fv-sr-date">' + (m.mtime ? fmtDate(m.mtime) : '') + '</span>' +
                    '</div>';
        }
        if (done && !list.length) html = '<div class="fv-sp-line">' + T('Nothing matched.') + '</div>';
        box.innerHTML = html;
    }

    function openFound(path, isDir) {
        if (isDir) { loadDir(path); return; }
        var parent = path.slice(0, path.lastIndexOf('/')) || '/';
        loadDir(parent).then(function () {
            var row = findRow(path);
            if (row) { openFile(row); if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' }); }
        });
    }

    var _recycleMode = false;
    var _rbScope = 'share';

    function resetRecycle() { _recycleMode = false; }

    function rbShareOk() {
        var parts = (_currentPath || '').split('/').filter(Boolean);
        return parts.length >= 3 && parts[0] === 'mnt';
    }

    function relTime(ts) {
        if (!ts) return '';
        var s = Math.floor(Date.now() / 1000) - ts;
        if (s < 60) return T('just now');
        var m = Math.floor(s / 60); if (m < 60) return m === 1 ? tf('%s minute ago', m) : tf('%s minutes ago', m);
        var h = Math.floor(m / 60); if (h < 24) return h === 1 ? tf('%s hour ago', h) : tf('%s hours ago', h);
        var d = Math.floor(h / 24); if (d === 1) return T('yesterday');
        if (d < 30) return tf('%s days ago', d);
        return new Date(ts * 1000).toLocaleDateString();
    }

    var RB_FILE_SVG   = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
    var RB_FOLDER_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
    var RB_TRASH_SVG  = '<svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg>';

    function enterRecycleMode() {
        leaveEditOk(function () { enterRecycleModeNow(); });
    }

    function enterRecycleModeNow() {
        resetPaneModes();
        _recycleMode = true;
        _rbScope = rbShareOk() ? 'share' : 'all';
        if (_pvEl) _pvEl.classList.add('fv-preview--active');
        renderPathCrumbs(null);
        _selectedFile = null; _previewFile = null;
        markActive(null);
        if (_pvToolsEl) _pvToolsEl.innerHTML = '';
        setFileTools(false, false);
        _bodyEl.innerHTML = '<div class="fv-rbpanel"><div class="fv-rb-loading">' + T('Loading the recycle bin') + '\u2026</div></div>';
        postJson('recycle_purge', { mode: 'expired', scope: 'all' }).then(loadRecycle, loadRecycle);
    }

    function loadRecycle() {
        if (!_recycleMode) return;
        var extra = 'scope=' + encodeURIComponent(_rbScope);
        if (_rbScope === 'share') extra += '&path=' + encodeURIComponent(_currentPath || '');
        fetchJson('recycle_list', extra).then(function (d) {
            if (!_recycleMode) return;
            if (!d || !d.ok) { renderRecycleError((d && d.error) || 'failed'); return; }
            renderRecycle(d);
        }).catch(function () {
            if (_recycleMode) renderRecycleError(T('network error'));
        });
    }

    function renderRecycleError(msg) {
        _bodyEl.innerHTML =
            '<div class="fv-rbpanel"><div class="fv-rb-empty">' + RB_TRASH_SVG +
            '<div class="h">' + T('Recycle Bin unavailable') + '</div><div class="s">' + esc(msg) + '</div></div></div>';
    }

    function rbAfterChange() {
        loadDir(_currentPath);
        _recycleMode = true;
        if (_pvEl) _pvEl.classList.add('fv-preview--active');
        _bodyEl.innerHTML = '<div class="fv-rbpanel"><div class="fv-rb-loading">' + T('Working') + '\u2026</div></div>';
        loadRecycle();
    }

    function renderRecycle(d) {
        var evs = d.events || [];
        var canShare = rbShareOk();
        var days = d.days || 30;
        var never = (days === 'never');

        var html = '<div class="fv-rbpanel">' +
            '<div class="fv-rb-top"><div class="fv-rb-title">' + T('Recycle Bin') + '</div>' +
              '<div class="fv-rb-seg">' +
                '<button type="button" class="fv-rb-segbtn' + (_rbScope === 'share' ? ' fv-rb-segbtn--on' : '') + '" id="fv-rb-share"' + (canShare ? '' : ' disabled') + '>' + T('This share') + '</button>' +
                '<button type="button" class="fv-rb-segbtn' + (_rbScope === 'all' ? ' fv-rb-segbtn--on' : '') + '" id="fv-rb-all">' + T('All shares') + '</button>' +
              '</div></div>';
        if (d.enabled === false) {
            html += '<div class="fv-rb-note">' + T('The recycle bin is turned off in Settings. New deletes are permanent, items below can still be restored.') + '</div>';
        }
        html += '<div class="fv-rb-policy">' + (never
            ? T('Items are kept until you empty the bin yourself.')
            : tf('Items older than %s days are emptied automatically.', days)) + '</div>';

        if (!evs.length) {
            html += '<div class="fv-rb-empty">' + RB_TRASH_SVG +
                    '<div class="h">' + T('Recycle Bin is empty') + '</div>' +
                    '<div class="s">' + (never
                        ? T('Deleted items appear here until you empty the bin.')
                        : tf('Deleted items appear here for %s days.', days)) + '</div></div>';
        } else {
            var totalSize = 0, anyPartial = false;
            html += '<div class="fv-rb-list">';
            evs.forEach(function (ev, i) {
                totalSize += ev.size || 0;
                if (ev.size_partial) anyPartial = true;
                var chip = ev.count > 1 ? esc(String(ev.count)) : (ev.kind === 'dir' ? RB_FOLDER_SVG : RB_FILE_SVG);
                var names = (ev.names || []).map(esc).join(', ');
                if (ev.count > (ev.names || []).length) names += ' ' + tf('+%s more', ev.count - ev.names.length);
                var cnt = ev.count === 1 ? (ev.kind === 'dir' ? T('1 folder') : T('1 item')) : tf('%s items', ev.count);
                var sub = esc(ev.share || '') + ' \u00b7 ' + esc(relTime(ev.deleted_at)) + ' \u00b7 ' + cnt;
                if (!ev.size_partial && ev.size > 0) sub += ' \u00b7 ' + fmtBytes(ev.size);
                if (ev.foreign) sub += ' \u00b7 <span class="fv-rb-foreign">' + tf('deleted from %s, cannot be restored here', esc(baseName(ev.foreign))) + '</span>';
                html += '<div class="fv-rb-ev">' +
                          '<div class="fv-rb-chip' + (ev.count > 1 ? ' fv-rb-chip--n' : '') + '">' + chip + '</div>' +
                          '<div class="fv-rb-main">' +
                            '<div class="fv-rb-name" title="' + esc((ev.names || []).join(', ')) + '">' + names + '</div>' +
                            '<div class="fv-rb-sub">' + sub + '</div>' +
                          '</div>' +
                          '<div class="fv-rb-act">' +
                            (ev.foreign ? '' : '<button type="button" class="fv-btn" data-rb="restore" data-i="' + i + '">' + T('Restore') + '</button>') +
                            '<button type="button" class="fv-btn fv-btn--danger" data-rb="purge" data-i="' + i + '">' + T('Delete forever') + '</button>' +
                          '</div>' +
                        '</div>';
            });
            html += '</div>';
            if (d.truncated) html += '<div class="fv-rb-note">' + T('Showing the newest 500 events only.') + '</div>';
            html += '<div class="fv-rb-foot">' +
                      '<div class="fv-rb-cnt">' + (evs.length === 1 ? tf('%s event', 1) : tf('%s events', evs.length)) +
                        (totalSize > 0 ? ' \u00b7 ' + fmtBytes(totalSize) + (anyPartial ? '+' : '') : '') + '</div>' +
                      '<button type="button" class="fv-btn fv-btn--danger" id="fv-rb-empty">' + T('Empty Recycle Bin') + '</button>' +
                    '</div>';
        }
        html += '</div>';
        _bodyEl.innerHTML = html;

        var panel = _bodyEl.querySelector('.fv-rbpanel');
        panel.addEventListener('click', function (e) {
            var b = e.target && e.target.closest ? e.target.closest('button') : null;
            if (!b || b.disabled) return;
            if (b.id === 'fv-rb-share') { if (_rbScope !== 'share') { _rbScope = 'share'; loadRecycle(); } return; }
            if (b.id === 'fv-rb-all')   { if (_rbScope !== 'all')   { _rbScope = 'all';   loadRecycle(); } return; }
            if (b.id === 'fv-rb-empty') { rbConfirmEmpty(evs.length); return; }
            var act = b.getAttribute('data-rb');
            if (!act) return;
            var ev = evs[parseInt(b.getAttribute('data-i'), 10)];
            if (!ev) return;
            if (act === 'restore') rbRestore(ev, b); else rbConfirmPurge(ev);
        });
    }

    function rbEventLabel(ev) {
        return ev.count === 1 ? esc((ev.names && ev.names[0]) || T('1 item')) : tf('%s items', ev.count);
    }

    function rbRestore(ev, btn) {
        btn.disabled = true;
        btn.textContent = T('Restoring') + '\u2026';
        postJson('recycle_restore', { event: ev.event }).then(function (d) {
            rbAfterChange();
            if (!d || !d.ok) {
                noteModal(T('Restore'), '<p class="fv-confirm">' + esc((d && d.error) || T('Restore failed.')) + '</p>');
            } else if (d.failed && d.failed.length) {
                noteModal(T('Restore'), '<p class="fv-confirm">' + T('Some items were not restored:') + '</p>' +
                    '<p class="fv-confirm" style="color:var(--fv-warn-text)">' + d.failed.map(esc).join('<br>') + '</p>');
            }
        });
    }

    function rbConfirmPurge(ev) {
        modalOpen(T('Delete forever'),
            '<p class="fv-confirm">' + tf('Permanently delete %s from the Recycle Bin? This cannot be undone.', '<b>' + rbEventLabel(ev) + '</b>') + '</p>' +
            '<div class="fv-modal__err" style="display:none"></div>',
            T('Delete forever'), 'fv-btn--danger', function (ov) {
                modalBusy(ov, true);
                postJson('recycle_purge', { mode: 'event', event: ev.event }).then(function (d) {
                    modalClose();
                    rbAfterChange();
                    if (!d || !d.ok) noteModal(T('Delete forever'), '<p class="fv-confirm">' + esc((d && d.error) || T('Purge failed.')) + '</p>');
                });
            });
    }

    function rbConfirmEmpty(n) {
        var where = _rbScope === 'share' ? T('this share') : T('all shares');
        modalOpen(T('Empty Recycle Bin'),
            '<p class="fv-confirm">' + tf('Permanently delete %s from the Recycle Bin of %s? This cannot be undone.', '<b>' + (n === 1 ? tf('%s event', 1) : tf('%s events', n)) + '</b>', where) + '</p>' +
            '<div class="fv-modal__err" style="display:none"></div>',
            T('Empty'), 'fv-btn--danger', function (ov) {
                modalBusy(ov, true);
                var p = { mode: 'all', scope: _rbScope };
                if (_rbScope === 'share') p.path = _currentPath || '';
                postJson('recycle_purge', p).then(function (d) {
                    modalClose();
                    rbAfterChange();
                    if (!d || !d.ok) noteModal(T('Empty Recycle Bin'), '<p class="fv-confirm">' + esc((d && d.error) || T('Purge failed.')) + '</p>');
                });
            });
    }

    var UP_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';

    function fmtBytes(n) {
        n = Number(n) || 0;
        var u = ['B','KB','MB','GB','TB'], i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
    }

    function beginCopyMove(op) {
        var paths = selectedPaths();
        if (paths.length) openDestPicker(op, paths);
    }

    function openDestPicker(op, paths) {
        var label = (op === 'move' ? T('Move') : T('Copy'));
        var cur = '', parent = null;
        var inner =
            '<div class="fv-pick">' +
              '<div class="fv-pick-bar"><button type="button" class="fv-pick-up" id="fv-pick-up" title="' + T('Up one folder') + '">' + UP_SVG + '</button>' +
                '<span class="fv-pick-path" id="fv-pick-path"></span></div>' +
              '<div class="fv-pick-list" id="fv-pick-list"></div>' +
              '<label class="fv-field"><span>' + T('If a name exists') + '</span>' +
                '<select class="fv-input" id="fv-pick-conf"><option value="rename">' + T('Keep both') + '</option><option value="overwrite">' + T('Overwrite') + '</option><option value="skip">' + T('Skip') + '</option></select>' +
              '</label>' +
            '</div><div class="fv-modal__err" style="display:none"></div>';

        var ov = modalOpen((paths.length > 1 ? tf('%s %s items to', label, paths.length) : tf('%s 1 item to', label)), inner,
            tf('%s here', label), 'fv-btn--primary', function (ov) {
                if (!cur) return;
                modalBusy(ov, true);
                startCopyMove(op, paths, cur, ov.querySelector('#fv-pick-conf').value, false, ov);
            });

        function render(d) {
            cur = d.path; parent = d.parent || null;
            ov.querySelector('#fv-pick-path').textContent = d.path || '/';
            ov.querySelector('#fv-pick-up').disabled = (parent === null);
            var dirs = (d.entries || []).filter(function (e) { return e.is_dir; });
            ov.querySelector('#fv-pick-list').innerHTML = dirs.length
                ? dirs.map(function (e) { return '<button type="button" class="fv-pick-row" data-p="' + esc(e.path) + '"><span class="fv-pick-ico">' + FOLDER_SVG + '</span>' + esc(e.name) + '</button>'; }).join('')
                : '<div class="fv-pick-empty">' + T('No subfolders here') + '</div>';
        }
        function load(p) {
            fetchJson('list', 'path=' + encodeURIComponent(p || '')).then(function (d) {
                if (!d || !d.ok) { modalError(ov, (d && d.error) || T('Cannot open folder.')); return; }
                render(d);
            });
        }
        ov.querySelector('#fv-pick-up').addEventListener('click', function () { if (parent !== null) load(parent); });
        ov.querySelector('#fv-pick-list').addEventListener('click', function (e) {
            var row = e.target.closest ? e.target.closest('.fv-pick-row') : null;
            if (row) load(row.getAttribute('data-p'));
        });
        load(_currentPath);
    }

    function startCopyMove(op, paths, dest, conflict, confirm, ov) {
        var body = { sources: JSON.stringify(paths), dest: dest, conflict: conflict };
        if (confirm) body.confirm = 1;
        postJson(op, body).then(function (d) {
            if (d && d.warn && !confirm) { confirmCrossMount(op, paths, dest, conflict, d.message); return; }
            if (!d || !d.ok) {
                var msg = (d && d.error) || T('Could not start.');
                if (ov) { modalError(ov, msg); modalBusy(ov, false); }
                else noteModal(op === 'move' ? T('Move') : T('Copy'), '<p class="fv-confirm">' + esc(msg) + '</p>');
                return;
            }
            openProgress(op, d.job);
        });
    }

    function confirmCrossMount(op, paths, dest, conflict, message) {
        modalOpen(T('Are you sure?'), '<p class="fv-confirm">' + esc(message || T('This may be risky.')) + '</p>',
            (op === 'move' ? T('Move anyway') : T('Copy anyway')), 'fv-btn--danger',
            function (ov) { modalBusy(ov, true); startCopyMove(op, paths, dest, conflict, true, ov); });
    }

    function openProgress(op, jobId) {
        var verb = { move: T('Moving'), copy: T('Copying'), extract: T('Extracting'), compress: T('Compressing') }[op];
        var act  = { move: T('moving %s'), copy: T('copying %s'), extract: T('extracting %s'), compress: T('packing %s') }[op];
        var doneMsg = { move: [T('Done. 1 item moved.'), T('Done. %s items moved.')],
                        copy: [T('Done. 1 item copied.'), T('Done. %s items copied.')],
                        extract: [T('Done. 1 item extracted.'), T('Done. %s items extracted.')],
                        compress: [T('Done. 1 file packed.'), T('Done. %s files packed.')] }[op];
        var cancelMsg = { move: T('Cancelled. Items already moved are in place.'),
                          copy: T('Cancelled. Items already copied are in place.'),
                          extract: T('Cancelled. What had come out was removed again.'),
                          compress: T('Cancelled. The archive was removed again.') }[op];
        var inner =
            '<div class="fv-prog">' +
              '<div class="fv-prog-bar"><div class="fv-prog-fill" id="fv-prog-fill"></div></div>' +
              '<div class="fv-prog-row"><span id="fv-prog-pct">0%</span><span id="fv-prog-bytes"></span></div>' +
              '<div class="fv-prog-row fv-prog-sub"><span id="fv-prog-count"></span><span id="fv-prog-eta"></span></div>' +
              '<div class="fv-prog-cur" id="fv-prog-cur">' + T('starting') + '…</div>' +
            '</div>';
        var done = false, timer = null, t0 = Date.now();
        var ov = modalOpen(verb, inner, T('Cancel'), 'fv-btn--danger', function (ov) {
            if (done) { modalClose(); return; }
            var btn = ov.querySelector('.fv-modal__ok');
            if (btn) { btn.disabled = true; btn.textContent = T('Cancelling') + '…'; }
            postJson('job_cancel', { id: jobId });
        }, true);

        function paint(st) {
            var bt = Number(st.bytes_total) || 0, bd = Number(st.bytes_done) || 0;
            var known = bt > 0 || st.state === 'done';
            var pct = bt > 0 ? Math.min(100, Math.round(bd / bt * 100)) : (st.state === 'done' ? 100 : 0);
            var fill = ov.querySelector('#fv-prog-fill');
            fill.style.width = known ? pct + '%' : '100%';
            fill.classList.toggle('fv-prog-fill--busy', !known);
            ov.querySelector('#fv-prog-pct').textContent = known ? pct + '%' : '';
            ov.querySelector('#fv-prog-bytes').textContent = known ? tf('%s of %s', fmtBytes(bd), fmtBytes(bt)) : fmtBytes(bd);
            ov.querySelector('#fv-prog-count').textContent = st.items_total > 0 ? tf('%s of %s items', st.items_done || 0, st.items_total) : tf('%s items', st.items_done || 0);
            ov.querySelector('#fv-prog-cur').textContent = st.current ? act.replace('%s', st.current) : '…';
            var el = (Date.now() - t0) / 1000, eta = '';
            if (bd > 0 && bt > bd && el > 1) {
                var rem = Math.round((bt - bd) / (bd / el));
                eta = rem > 90 ? tf('~%sm left', Math.round(rem / 60)) : tf('~%ss left', rem);
            }
            ov.querySelector('#fv-prog-eta').textContent = eta;
        }
        function finish(st) {
            done = true; if (timer) { clearInterval(timer); timer = null; }
            var fails = (st && st.failed) || [], msg;
            if (st && st.state === 'cancelled') msg = cancelMsg;
            else if (st && st.state === 'error') msg = T('Something went wrong.') + ' ' + ((st && st.message) || '') + (op === 'extract' || op === 'compress' ? ' ' + T('Nothing was left behind.') : '');
            else {
                var n = st.items_done || 0;
                msg = n === 1 ? doneMsg[0] : doneMsg[1].replace('%s', n);
                var sk = Number(st.skipped) || 0;
                if (sk) msg += ' ' + (op === 'compress'
                    ? (sk === 1 ? T('1 link was left out.') : tf('%s links were left out.', sk))
                    : (sk === 1 ? T('1 link or special entry was left out.') : tf('%s links or special entries were left out.', sk)));
                if ((op === 'compress' || op === 'extract') && st.name) msg += ' ' + tf('Saved as %s.', st.name);
            }
            var extra = fails.length ? '<p class="fv-confirm" style="color:var(--fv-warn-text)">' + T('Skipped:') + '<br>' + fails.map(esc).join('<br>') + '</p>' : '';
            var b = ov.querySelector('.fv-modal__body'); if (b) b.innerHTML = '<p class="fv-confirm">' + esc(msg) + '</p>' + extra;
            var btn = ov.querySelector('.fv-modal__ok');
            if (btn) { btn.disabled = false; btn.textContent = T('Close'); btn.className = 'fv-btn fv-btn--primary fv-modal__ok'; }
            loadDir(_currentPath);
        }
        function poll() {
            fetchJson('job_status', 'id=' + encodeURIComponent(jobId)).then(function (d) {
                if (!d || !d.ok) return;
                var st = d.status || {};
                try { paint(st); } catch (e) {}
                if (st.state === 'done' || st.state === 'cancelled' || st.state === 'error') finish(st);
            });
        }
        timer = setInterval(poll, 1000);
        poll();
    }

    function applyToEach(action, paths, paramsFor, label) {
        var failed = [];
        (function next(i) {
            if (i >= paths.length) {
                modalClose();
                refreshRows(paths);
                if (failed.length) {
                    noteModal(label, '<p class="fv-confirm">' + T('Some items were not changed:') + '</p>' +
                        '<p class="fv-confirm" style="color:var(--fv-warn-text)">' + failed.map(esc).join('<br>') + '</p>');
                }
                return;
            }
            postJson(action, paramsFor(paths[i])).then(function (d) {
                if (!d || !d.ok) failed.push(baseName(paths[i]) + ' - ' + ((d && d.error) || 'failed'));
                next(i + 1);
            });
        })(0);
    }

    var PERM_BITS = [256,128,64, 32,16,8, 4,2,1];

    function readPermOctal(ov) {
        var sum = 0, bits = ov.querySelectorAll('.fv-permbit');
        for (var i = 0; i < bits.length; i++) if (bits[i].checked) sum += Number(bits[i].getAttribute('data-v'));
        var s = sum.toString(8);
        while (s.length < 3) s = '0' + s;
        return s;
    }

    function permSymbolic(oct, isDir, special) {
        var n  = parseInt(oct, 8) || 0;
        var sp = parseInt(special || '0', 8) || 0;
        var t = 'rwxrwxrwx', out = '';
        for (var i = 0; i < 9; i++) out += (n & (1 << (8 - i))) ? t.charAt(i) : '-';
        if (sp & 4) out = out.slice(0, 2) + ((n & 64) ? 's' : 'S') + out.slice(3);
        if (sp & 2) out = out.slice(0, 5) + ((n & 8)  ? 's' : 'S') + out.slice(6);
        if (sp & 1) out = out.slice(0, 8) + ((n & 1)  ? 't' : 'T');
        return (isDir ? 'd' : '-') + out;
    }

    function permPreview(ov, isDir, special) {
        var oct = readPermOctal(ov);
        if (_permsFmt === 'symbolic') return permSymbolic(oct, isDir, special);
        return (special && special !== '0' ? special : '') + oct;
    }

    function promptPermission() {
        var paths = selectedPaths();
        if (!paths.length) return;
        fetchJson('attrs', 'path=' + encodeURIComponent(paths[0])).then(function (a) {
            if (!a || !a.ok) { noteModal(T('Permission'), '<p class="fv-confirm">' + esc((a && a.error) || T('Cannot read attributes.')) + '</p>'); return; }
            openPermissionDialog(paths, a);
        });
    }

    function openPermissionDialog(paths, a) {
        var mode = parseInt(a.mode, 8) || 0;
        var rows = [T('Owner'), T('Group'), T('Other')];
        var grid = '<table class="fv-perm"><tr><th></th><th>r</th><th>w</th><th>x</th></tr>';
        for (var r = 0; r < 3; r++) {
            grid += '<tr><td>' + rows[r] + '</td>';
            for (var c = 0; c < 3; c++) {
                var bit = PERM_BITS[r * 3 + c];
                grid += '<td><input type="checkbox" class="fv-permbit" data-v="' + bit + '"' + ((mode & bit) ? ' checked' : '') + '></td>';
            }
            grid += '</tr>';
        }
        grid += '</table>';

        var inner =
            (paths.length > 1 ? '<p class="fv-confirm" style="margin-bottom:.6rem">' + tf('Applies to %s items.', paths.length) + '</p>' : '') +
            grid +
            '<div class="fv-permline">' + T('Mode') + ' <code id="fv-perm-oct">000</code></div>' +
            '<label class="fv-check"><input type="checkbox" id="fv-perm-rec"> ' + T('Apply to all contents (folders)') + '</label>' +
            defaultsRowHtml() +
            '<div class="fv-modal__err" style="display:none"></div>';

        var isDir = !!a.is_dir;
        var special = (typeof a.mode === 'string' && a.mode.length === 4) ? a.mode.charAt(0) : '0';
        var ov = modalOpen(T('Permission'), inner, T('Apply'), 'fv-btn--primary', function (ov) {
            var oct = (special !== '0' ? special : '') + readPermOctal(ov);
            var rec = ov.querySelector('#fv-perm-rec').checked ? 1 : '';
            modalBusy(ov, true);
            applyToEach('chmod', paths, function (p) { return { path: p, mode: oct, recursive: rec }; }, T('Permission'));
        });

        var sync = function () { ov.querySelector('#fv-perm-oct').textContent = permPreview(ov, isDir, special); };
        var bits = ov.querySelectorAll('.fv-permbit');
        for (var i = 0; i < bits.length; i++) bits[i].addEventListener('change', sync);
        sync();
        bindDefaults(ov, paths);
    }

    function defaultsRowHtml() {
        return '<div class="fv-defaults"><span>' + T('nobody:users, folders 777, files 666') + '</span>' +
               '<button type="button" class="fv-btn" id="fv-defaults">' + T('Unraid defaults') + '</button></div>';
    }
    function bindDefaults(ov, paths) {
        var b = ov.querySelector('#fv-defaults');
        if (b) b.addEventListener('click', function () { promptNewPerms(paths); });
    }
    function promptNewPerms(paths) {
        var what = paths.length === 1 ? '<b>' + esc(baseName(paths[0])) + '</b>' : '<b>' + tf('%s items', paths.length) + '</b>';
        var inner =
            '<p class="fv-confirm">' + tf('Set %s and everything inside to nobody:users, folders 777 and files 666?', what) + '</p>' +
            '<p class="fv-confirm" style="color:var(--fv-text-dim)">' + T('The same as New Permissions in Tools, for these items only. Links are left as they are.') + '</p>' +
            '<div class="fv-modal__err" style="display:none"></div>';
        modalOpen(T('Unraid defaults'), inner, T('Apply'), 'fv-btn--primary', function (ov) {
            modalBusy(ov, true);
            applyToEach('newperms', paths, function (p) { return { path: p }; }, T('Unraid defaults'));
        });
    }

    function promptOwner() {
        var paths = selectedPaths();
        if (!paths.length) return;
        fetchJson('attrs', 'path=' + encodeURIComponent(paths[0])).then(function (a) {
            if (!a || !a.ok) { noteModal(T('Owner'), '<p class="fv-confirm">' + esc((a && a.error) || T('Cannot read attributes.')) + '</p>'); return; }
            openOwnerDialog(paths, a);
        });
    }

    function openOwnerDialog(paths, a) {
        var inner =
            (paths.length > 1 ? '<p class="fv-confirm" style="margin-bottom:.6rem">' + tf('Applies to %s items.', paths.length) + '</p>' : '') +
            '<label class="fv-field"><span>' + T('User') + '</span><input type="text" class="fv-input" id="fv-own-user" autocomplete="off" spellcheck="false" value="' + esc(a.owner) + '"></label>' +
            '<label class="fv-field"><span>' + T('Group') + '</span><input type="text" class="fv-input" id="fv-own-group" autocomplete="off" spellcheck="false" value="' + esc(a.group) + '"></label>' +
            '<p class="fv-hint">' + T('Name or numeric id. Leave a field empty to keep it as is.') + '</p>' +
            '<label class="fv-check"><input type="checkbox" id="fv-own-rec"> ' + T('Apply to all contents (folders)') + '</label>' +
            defaultsRowHtml() +
            '<div class="fv-modal__err" style="display:none"></div>';

        var ov = modalOpen(T('Owner'), inner, T('Apply'), 'fv-btn--primary', function (ov) {
            var user  = ov.querySelector('#fv-own-user').value.trim();
            var group = ov.querySelector('#fv-own-group').value.trim();
            if (!user && !group) { modalError(ov, T('Set a user or a group.')); return; }
            var rec = ov.querySelector('#fv-own-rec').checked ? 1 : '';
            modalBusy(ov, true);
            applyToEach('chown', paths, function (p) { return { path: p, user: user, group: group, recursive: rec }; }, T('Owner'));
        });
        ov.querySelector('#fv-own-user').focus();
        bindDefaults(ov, paths);
    }

    function resetEditState() {
        _editing = false;
        _editBaseline = '';
        _editMtime = 0;
        _editCtx = null;
    }
    function editorDirty() {
        var ta = document.getElementById('fv-editor');
        return _editing && !!ta && ta.value !== _editBaseline;
    }
    function leaveEditOk(onOk, onCancel) {
        if (!_editing)      { onOk(); return; }
        if (!editorDirty()) { resetEditState(); onOk(); return; }

        var done = false;
        _modalOnClose = function () { if (!done) { done = true; if (onCancel) onCancel(); } };
        modalOpen(T('Unsaved changes'),
            '<p class="fv-confirm">' + T('This file has changes that were not saved. Leaving now discards them.') + '</p>',
            T('Discard'), 'fv-btn--danger',
            function () { done = true; modalClose(); resetEditState(); onOk(); });
    }

    function enterEdit() {
        if (!_editMode) return;
        var ctx = _previewFile;
        if (!ctx || (ctx.cat !== 'code' && ctx.cat !== 'md')) return;
        fetchJson('filetext', 'path=' + encodeURIComponent(ctx.path)).then(function (d) {
            if (!d || !d.ok) { noteModal(T('Edit'), '<p class="fv-confirm">' + esc((d && d.error) || T('This file cannot be edited.')) + '</p>'); return; }
            openEditor(ctx, d.content, d.mtime);
        });
    }

    function openEditor(ctx, content, mtime) {
        _editing = true; _editCtx = ctx; _editMtime = mtime; _editBaseline = content;
        setPvHead(ctx.name, (ctx.ext ? '.' + ctx.ext : T('Text')) + ' \u00b7 ' + T('editing'), 'code');
        _bodyEl.innerHTML =
            '<div class="fv-ed">' +
              '<div class="fv-ed__find" id="fv-ed-find" hidden>' +
                '<input type="text" class="fv-input fv-ed__q" id="fv-ed-q" placeholder="' + T('Find') + '" autocomplete="off" spellcheck="false">' +
                '<label class="fv-ed__case" title="' + T('Match case') + '"><input type="checkbox" id="fv-ed-case"> Aa</label>' +
                '<span class="fv-ed__hits" id="fv-ed-hits"></span>' +
                '<button type="button" class="fv-btn fv-ed__b" id="fv-ed-prev" title="' + T('Previous') + '">\u25b4</button>' +
                '<button type="button" class="fv-btn fv-ed__b" id="fv-ed-next" title="' + T('Next') + '">\u25be</button>' +
                '<input type="text" class="fv-input fv-ed__r" id="fv-ed-r" placeholder="' + T('Replace with') + '" autocomplete="off" spellcheck="false">' +
                '<button type="button" class="fv-btn fv-ed__b" id="fv-ed-rep">' + T('Replace') + '</button>' +
                '<button type="button" class="fv-btn fv-ed__b" id="fv-ed-repall">' + T('Replace all') + '</button>' +
                '<button type="button" class="fv-btn fv-ed__b fv-ed__x" id="fv-ed-close" title="' + T('Close') + '">\u00d7</button>' +
              '</div>' +
              '<div class="fv-ed__box"><pre class="fv-ed__gutter" id="fv-ed-gutter" aria-hidden="true"></pre>' +
                '<textarea id="fv-editor" class="fv-editor" spellcheck="false" wrap="off"></textarea></div>' +
              '<div class="fv-ed__status" id="fv-ed-status"></div>' +
            '</div>';
        var ta = document.getElementById('fv-editor');
        ta.value = content;
        var save = addTool(T('Save'), T('Save changes') + ' (Ctrl+S)', function () { saveEdit(false); });
        save.classList.add('fv-pv-btn--primary');
        addTool(T('Find'), T('Find and replace') + ' (Ctrl+F)', function () { edShowFind(false); });
        addTool(T('Cancel'), T('Discard changes'), cancelEdit);
        edBind(ta);
        ta.focus();
        ta.setSelectionRange(0, 0);
        ta.scrollTop = 0;
        if (ta.fvStatus) ta.fvStatus();
    }

    function edBind(ta) {
        var gutter = document.getElementById('fv-ed-gutter');
        var lines = -1;
        function renumber() {
            var n = ta.value.split('\n').length;
            if (n === lines) return;
            lines = n;
            var g = '';
            for (var i = 1; i <= n; i++) g += i + '\n';
            gutter.textContent = g;
        }
        function status() {
            var pos = ta.selectionStart, before = ta.value.slice(0, pos);
            var ln = before.split('\n').length, col = pos - before.lastIndexOf('\n');
            var el = document.getElementById('fv-ed-status');
            if (el) el.textContent = tf('Ln %s, Col %s', ln, col) + ' \u00b7 ' + (lines === 1 ? T('1 line') : tf('%s lines', lines)) +
                                     (ta.selectionEnd > pos ? ' \u00b7 ' + tf('%s selected', ta.selectionEnd - pos) : '') +
                                     (editorDirty() ? ' \u00b7 ' + T('modified') : '');
        }
        ta.addEventListener('scroll', function () { gutter.scrollTop = ta.scrollTop; });
        ta.addEventListener('input', function () { renumber(); status(); edRecount(); });
        ta.addEventListener('keyup', status);
        ta.addEventListener('click', status);
        ta.addEventListener('select', status);
        ta.addEventListener('keydown', function (e) {
            var mod = e.ctrlKey || e.metaKey;
            if (mod && !e.altKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); edShowFind(false); }
            else if (mod && !e.altKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); edShowFind(true); }
            else if (mod && !e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveEdit(false); }
            else if (e.key === 'F3') { e.preventDefault(); edFind(e.shiftKey ? -1 : 1); }
            else if (e.key === 'Tab' && !e.shiftKey && !mod) {
                e.preventDefault();
                ta.setRangeText('\t', ta.selectionStart, ta.selectionEnd, 'end');
                ta.dispatchEvent(new Event('input'));
            }
        });
        var bar = document.getElementById('fv-ed-find');
        var q = document.getElementById('fv-ed-q');
        q.addEventListener('input', function () { edFind(0); });
        document.getElementById('fv-ed-case').addEventListener('change', function () { edFind(0); });
        bar.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); if (e.target.id === 'fv-ed-r') edReplace(); else edFind(e.shiftKey ? -1 : 1); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); edHideFind(); }
            else if (e.key === 'F3') { e.preventDefault(); edFind(e.shiftKey ? -1 : 1); }
        });
        document.getElementById('fv-ed-prev').addEventListener('click', function () { edFind(-1); });
        document.getElementById('fv-ed-next').addEventListener('click', function () { edFind(1); });
        document.getElementById('fv-ed-rep').addEventListener('click', edReplace);
        document.getElementById('fv-ed-repall').addEventListener('click', edReplaceAll);
        document.getElementById('fv-ed-close').addEventListener('click', edHideFind);
        renumber();
        status();
        ta.fvStatus = status;
    }

    function edTa() { return document.getElementById('fv-editor'); }
    function edShowFind(replace) {
        var ta = edTa(), bar = document.getElementById('fv-ed-find');
        if (!ta || !bar) return;
        bar.hidden = false;
        var q = document.getElementById('fv-ed-q');
        var sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        if (sel && sel.indexOf('\n') === -1) q.value = sel;
        var target = replace ? document.getElementById('fv-ed-r') : q;
        target.focus(); target.select();
        edRecount();
    }
    function edHideFind() {
        var bar = document.getElementById('fv-ed-find'), ta = edTa();
        if (bar) bar.hidden = true;
        if (ta) ta.focus();
    }
    function edMatches() {
        var ta = edTa(), q = document.getElementById('fv-ed-q');
        if (!ta || !q || !q.value) return [];
        var cs = document.getElementById('fv-ed-case').checked;
        var hay = cs ? ta.value : ta.value.toLowerCase(), needle = cs ? q.value : q.value.toLowerCase();
        var out = [], i = 0;
        while (out.length < 20000) {
            i = hay.indexOf(needle, i);
            if (i < 0) break;
            out.push(i); i += needle.length || 1;
        }
        return out;
    }
    function edRecount() {
        var hits = document.getElementById('fv-ed-hits'), bar = document.getElementById('fv-ed-find');
        if (!hits || !bar || bar.hidden) return;
        var m = edMatches(), ta = edTa(), q = document.getElementById('fv-ed-q');
        if (!q.value) { hits.textContent = ''; return; }
        var cur = -1;
        for (var i = 0; i < m.length; i++) if (m[i] === ta.selectionStart && ta.selectionEnd === m[i] + q.value.length) { cur = i; break; }
        hits.textContent = m.length ? ((cur >= 0 ? (cur + 1) + ' / ' : '') + (m.length >= 20000 ? '20000+' : m.length)) : T('no matches');
        hits.classList.toggle('fv-sp-warn', !m.length);
    }
    function edFind(dir) {
        var ta = edTa(), q = document.getElementById('fv-ed-q');
        if (!ta || !q) return false;
        var m = edMatches();
        if (!m.length) { edRecount(); return false; }
        var len = q.value.length, pick = -1;
        if (dir > 0) {
            for (var i = 0; i < m.length; i++) if (m[i] >= ta.selectionEnd || (m[i] === ta.selectionStart && ta.selectionEnd - ta.selectionStart !== len)) { pick = i; break; }
            if (pick < 0) pick = 0;
        } else if (dir < 0) {
            for (var j = m.length - 1; j >= 0; j--) if (m[j] < ta.selectionStart) { pick = j; break; }
            if (pick < 0) pick = m.length - 1;
        } else {
            for (var k = 0; k < m.length; k++) if (m[k] >= ta.selectionStart) { pick = k; break; }
            if (pick < 0) pick = 0;
        }
        var pos = m[pick];
        ta.setSelectionRange(pos, pos + len);
        var line = ta.value.slice(0, pos).split('\n').length - 1;
        var lh = parseFloat(getComputedStyle(ta).lineHeight) || 20;
        var top = line * lh;
        if (top < ta.scrollTop || top > ta.scrollTop + ta.clientHeight - lh * 2) ta.scrollTop = Math.max(0, top - ta.clientHeight / 2);
        edRecount();
        if (ta.fvStatus) ta.fvStatus();
        return true;
    }
    function edReplace() {
        var ta = edTa(), q = document.getElementById('fv-ed-q'), r = document.getElementById('fv-ed-r');
        if (!ta || !q || !q.value) return;
        var cs = document.getElementById('fv-ed-case').checked;
        var sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
        var same = cs ? sel === q.value : sel.toLowerCase() === q.value.toLowerCase();
        if (same) {
            ta.setRangeText(r.value, ta.selectionStart, ta.selectionEnd, 'end');
            ta.dispatchEvent(new Event('input'));
        }
        edFind(1);
    }
    function edReplaceAll() {
        var ta = edTa(), q = document.getElementById('fv-ed-q'), r = document.getElementById('fv-ed-r');
        if (!ta || !q || !q.value) return;
        var m = edMatches();
        if (!m.length) { edRecount(); return; }
        var pos = ta.selectionStart;
        var v = ta.value, out = '', last = 0;
        for (var i = 0; i < m.length; i++) { out += v.slice(last, m[i]) + r.value; last = m[i] + q.value.length; }
        ta.value = out + v.slice(last);
        ta.setSelectionRange(Math.min(pos, ta.value.length), Math.min(pos, ta.value.length));
        ta.dispatchEvent(new Event('input'));
        var hits = document.getElementById('fv-ed-hits');
        if (hits) { hits.textContent = tf('%s replaced', m.length); hits.classList.remove('fv-sp-warn'); }
    }

    function setEditorBusy(on) {
        var b = _pvToolsEl ? _pvToolsEl.querySelector('.fv-pv-btn--primary') : null;
        if (b) b.disabled = !!on;
    }
    function flashSaved() {
        var b = _pvToolsEl ? _pvToolsEl.querySelector('.fv-pv-btn--primary') : null;
        if (!b) return;
        var t = b.textContent;
        b.textContent = T('Saved'); b.classList.add('active');
        setTimeout(function () { if (b) { b.textContent = t; b.classList.remove('active'); } }, 1200);
    }

    function saveEdit(force) {
        var ta = document.getElementById('fv-editor');
        if (!ta || !_editCtx) return;
        var content = ta.value;
        setEditorBusy(true);
        postJson('save', { path: _editCtx.path, content: content, mtime: _editMtime, force: force ? 1 : '' }).then(function (d) {
            setEditorBusy(false);
            if (d && d.ok) { _editBaseline = content; _editMtime = d.mtime; flashSaved(); if (ta.fvStatus) ta.fvStatus(); return; }
            if (d && d.stale) { confirmStale(); return; }
            noteModal(T('Save'), '<p class="fv-confirm" style="color:var(--fv-warn-text)">' + esc((d && d.error) || T('Could not save.')) + '</p>');
        });
    }

    function confirmStale() {
        modalOpen(T('File changed on disk'),
            '<p class="fv-confirm">' + T('This file was changed outside the editor since you opened it. Overwrite it with your version?') + '</p>',
            T('Overwrite'), 'fv-btn--danger', function () { modalClose(); saveEdit(true); });
    }

    function cancelEdit() {
        if (editorDirty()) {
            modalOpen(T('Discard changes'), '<p class="fv-confirm">' + T('Discard your unsaved changes?') + '</p>',
                T('Discard'), 'fv-btn--danger', function () { modalClose(); exitToPreview(); });
            return;
        }
        exitToPreview();
    }
    function exitToPreview() {
        var ctx = _editCtx;
        resetEditState();
        if (ctx) doOpen(ctx.cat, ctx.size, ctx.name, ctx.ext, ctx.path);
    }

    function init() {
        _listEl   = document.getElementById('fv-list');
        _crumbEl  = document.getElementById('fv-pv-crumbs');
        _bodyEl   = document.getElementById('fv-pv-body');
        _titleEl  = document.getElementById('fv-browser-title');
        _countEl  = document.getElementById('fv-browser-count');
        _pvTypeEl = document.getElementById('fv-pv-type');
        _pvToolsEl = document.getElementById('fv-pv-tools');
        _filterEl  = document.getElementById('fv-filter-input');
        _pvEl      = document.querySelector('.fv-preview');
        _rootEl    = document.querySelector('.fv-wrapper');
        _pvCloseEl = document.getElementById('fv-pv-close');
        _filterWideEl   = document.getElementById('fv-filter-wide');
        _filterNarrowEl = document.getElementById('fv-filter-input');
        _sideBtn      = document.getElementById('fv-op-side');
        _starEl    = document.getElementById('fv-pv-star');
        _favBtn    = document.getElementById('fv-op-fav');
        _favMenuEl = document.getElementById('fv-fav-menu');
        _dlBtn     = document.getElementById('fv-op-download');
        _wrapBtn   = document.getElementById('fv-op-wrap');
        _rawBtn    = document.getElementById('fv-op-openraw');
        _createBtn = document.getElementById('fv-op-create');
        _compressBtn = document.getElementById('fv-op-compress');
        _pathBtn   = document.getElementById('fv-op-path');
        _locateBtn = document.getElementById('fv-op-locate');
        _searchBtn = document.getElementById('fv-op-search');
        _hashBtn   = document.getElementById('fv-op-hash');
        _renameBtn = document.getElementById('fv-op-rename');
        _deleteBtn = document.getElementById('fv-op-delete');
        _editBtn   = document.getElementById('fv-op-edit');
        _ownerBtn  = document.getElementById('fv-op-owner');
        _permBtn   = document.getElementById('fv-op-perm');
        _copyBtn   = document.getElementById('fv-op-copy');
        _moveBtn   = document.getElementById('fv-op-move');
        _uploadBtn = document.getElementById('fv-op-upload');
        _recycleBtn = document.getElementById('fv-op-recycle');
        _spaceBtn = document.getElementById('fv-op-space');
        EMPTY_HTML = _bodyEl ? _bodyEl.innerHTML : '';
        if (!_listEl) return;

        _listEl.addEventListener('click', onListClick);
        _listEl.addEventListener('mousedown', onPickDown);
        if (_bodyEl) _bodyEl.addEventListener('mousedown', onPickDown);
        _crumbEl.addEventListener('click', onCrumbClick);
        if (_pvCloseEl) _pvCloseEl.addEventListener('click', function () { leaveEditOk(clearPreview); });
        if (_bodyEl) _bodyEl.addEventListener('click', function (e) {
            if (e.target && e.target.type === 'checkbox') { onPickClick(e); return; }
            var sr = e.target.closest ? e.target.closest('.fv-sr-row') : null;
            if (sr) { openFound(sr.getAttribute('data-path'), sr.getAttribute('data-dir') === '1'); return; }
            var th = e.target.closest ? e.target.closest('th[data-key]') : null;
            if (th) { setSort(th.getAttribute('data-key')); return; }
            var tr = e.target.closest ? e.target.closest('.fv-fo__row') : null;
            if (!tr) return;
            if (e.target.classList && e.target.classList.contains('fv-fo__meas')) {
                var cell = e.target.parentNode;
                measureRow(cell, tr.getAttribute('data-path'));
                return;
            }
            var path = tr.getAttribute('data-path');
            if (tr.getAttribute('data-dir') === '1') { openFolderRow(tr, path); return; }
            var row = findRow(path);
            if (row) openFile(row);
        });

        if (_sideBtn) _sideBtn.addEventListener('click', function (e) { e.preventDefault(); setSplit(!_split); });
        if (_filterWideEl) _filterWideEl.addEventListener('input', applyFilter);

        if (_bodyEl) _bodyEl.addEventListener('change', function (e) {
            var t = e.target;
            if (!t) return;
            if (t.id === 'fv-fo-all') {
                if (t.checked) { selectAllVisible(); return; }
                _selected = {};
                syncListChecks();
                updateSelUi();
                return;
            }
            if (t.classList && t.classList.contains('fv-focb')) {
                var row = t.closest('.fv-fo__row');
                if (!row) return;
                var p = row.getAttribute('data-path');
                if (t.checked) _selected[p] = true; else delete _selected[p];
                syncListChecks();
                updateSelUi();
            }
        });

        if (_starEl) _starEl.addEventListener('click', favToggle);
        if (_favBtn) _favBtn.addEventListener('click', function (e) { e.stopPropagation(); favMenuToggle(); });
        if (_favMenuEl) _favMenuEl.addEventListener('click', function (e) {
            var b = e.target.closest ? e.target.closest('.fv-fav-item') : null;
            if (b) favGo(b.getAttribute('data-path'));
        });
        document.addEventListener('click', function (e) {
            if (!_favOpen) return;
            if (_favMenuEl && _favMenuEl.contains(e.target)) return;
            if (_favBtn && _favBtn.contains(e.target)) return;
            favMenuClose();
        });
        if (_dlBtn) _dlBtn.addEventListener('click', downloadSelected);
        if (_wrapBtn) _wrapBtn.addEventListener('click', toggleWrap);
        if (_rawBtn) _rawBtn.addEventListener('click', openRawSelected);
        if (_createBtn) _createBtn.addEventListener('click', promptCreate);
        if (_renameBtn) _renameBtn.addEventListener('click', promptRename);
        if (_deleteBtn) _deleteBtn.addEventListener('click', promptDelete);
        if (_editBtn) _editBtn.addEventListener('click', enterEdit);
        if (_ownerBtn) _ownerBtn.addEventListener('click', promptOwner);
        if (_permBtn) _permBtn.addEventListener('click', promptPermission);
        if (_copyBtn) _copyBtn.addEventListener('click', function () { beginCopyMove('copy'); });
        if (_moveBtn) _moveBtn.addEventListener('click', function () { beginCopyMove('move'); });
        if (_uploadBtn) _uploadBtn.addEventListener('click', enterUploadMode);
        if (_recycleBtn) _recycleBtn.addEventListener('click', enterRecycleMode);
        if (_spaceBtn) _spaceBtn.addEventListener('click', enterSpaceMode);
        if (_compressBtn) _compressBtn.addEventListener('click', promptCompress);
        if (_pathBtn) _pathBtn.addEventListener('click', copyPath);
        if (_locateBtn) _locateBtn.addEventListener('click', promptLocate);
        if (_searchBtn) _searchBtn.addEventListener('click', enterSearchMode);
        if (_hashBtn) _hashBtn.addEventListener('click', promptChecksum);
        _listEl.addEventListener('change', onListChange);
        updateOps();

        if (_filterEl) _filterEl.addEventListener('input', applyFilter);
        var modeBtn = document.getElementById('fv-mode');
        if (modeBtn) modeBtn.addEventListener('click', function (e) { e.preventDefault(); setMode(!_editMode); });
        document.addEventListener('keydown', onKey);
        window.addEventListener('beforeunload', function (e) {
            if (!editorDirty() && !_upActive) return;
            e.preventDefault();
            e.returnValue = '';
        });

        setMode(!!_cfg.editDefault);
        setSplit(sideOn());
        favLoad();
        loadDir(readDir(), true).then(spResume);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
