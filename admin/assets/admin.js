/* Computing and Vision Lab — site editor.
 *
 * Talks to the same-origin API with the session cookie the server set at login.
 * The cookie is httpOnly, so this file never sees or stores a token; a 401 from
 * any call simply drops the editor back to the sign-in screen.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------ plumbing

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function el(id) { return document.getElementById(id); }

  var gate = el('gate'), app = el('app');

  async function api(method, path, body) {
    var res = await fetch('/api' + path, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });

    if (res.status === 401) {
      showGate();
      throw new Error('Your session ended. Sign in again.');
    }

    var data = null;
    try { data = await res.json(); } catch (e) { /* 204 or non-JSON */ }

    if (!res.ok) {
      throw new Error((data && data.error) || ('Request failed (HTTP ' + res.status + ')'));
    }
    return data;
  }

  var toastTimer = null;
  function toast(message, bad) {
    var t = el('toast');
    t.textContent = message;
    t.className = 'toast' + (bad ? ' bad' : '');
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, bad ? 6000 : 2800);
  }

  // ------------------------------------------------------------ sign in

  function showGate() {
    gate.hidden = false;
    app.hidden = true;
  }
  function showApp() {
    gate.hidden = true;
    app.hidden = false;
  }

  el('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var btn = el('login-btn'), err = el('login-error');
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Signing in…';

    try {
      await api('POST', '/auth/login', {
        username: el('u').value,
        password: el('p').value
      });
      el('p').value = '';
      showApp();
      switchView('members');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  // ------------------------------------------------------ view registry

  var MEMBER_GROUPS = [
    ['pi', 'Lab in-charge'],
    ['phd', 'Ph.D. scholars'], ['mtech', 'M.Tech. students'],
    ['btech', 'B.Tech. project students'], ['staff', 'Staff'], ['alumni', 'Alumni']
  ];

  var RESEARCH_KINDS = [
    ['theme', 'Research directions'], ['patent', 'Patents'],
    ['journal', 'Journal articles'], ['chapter', 'Book chapters'],
    ['conference', 'Conference papers'], ['talk', 'Invited talks'],
    ['organized', 'Events organized'], ['chaired', 'Conferences chaired']
  ];

  function opts(pairs, selected) {
    return pairs.map(function (p) {
      var v = Array.isArray(p) ? p[0] : p, l = Array.isArray(p) ? p[1] : p;
      return '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' +
        esc(l) + '</option>';
    }).join('');
  }

  function field(name, label, value, o) {
    o = o || {};
    var id = 'f_' + name;
    var input;
    if (o.type === 'textarea') {
      input = '<textarea id="' + id + '" name="' + name + '"' +
        (o.rows ? ' rows="' + o.rows + '"' : '') + '>' + esc(value) + '</textarea>';
    } else if (o.type === 'select') {
      input = '<select id="' + id + '" name="' + name + '">' + opts(o.options, value == null ? '' : String(value)) + '</select>';
    } else {
      input = '<input id="' + id + '" name="' + name + '" type="' + (o.type || 'text') + '" value="' + esc(value) + '"' +
        (o.min !== undefined ? ' min="' + o.min + '"' : '') + '>';
    }
    return '<label for="' + id + '">' + esc(label) + '</label>' + input +
      (o.hint ? '<p class="fieldhint">' + esc(o.hint) + '</p>' : '');
  }

  /**
   * Photo field. Uploads as soon as a file is chosen rather than on form
   * submit, so the admin sees the processed result — cropped square, EXIF
   * stripped — before committing, and a failed upload does not lose the rest of
   * the form. The hidden input carries the stored path and is what gets saved.
   */
  function photoField(name, label, value, opts) {
    var o = opts || {};
    var variant = o.variant || 'portrait';
    var v = String(value || '');
    return '<label>' + esc(label) + '</label>' +
      '<div class="photofield" data-photofield="' + name + '" data-variant="' + esc(variant) + '">' +
        '<div class="photoprev" data-preview>' +
          // The editor is always same-origin with the API, so a stored
          // "/api/photos/<id>" path resolves as-is. Only the public pages,
          // which may sit on a different origin, need the API base prepended.
          (v ? '<img src="' + esc(v) + '" alt="">' : '<span>No photo</span>') +
        '</div>' +
        '<div class="photoacts">' +
          '<input type="hidden" name="' + name + '" value="' + esc(v) + '">' +
          '<input type="file" accept="image/*" hidden data-file>' +
          '<button type="button" class="btn" data-pick>' +
            (v ? 'Replace photo' : 'Upload photo') + '</button>' +
          '<button type="button" class="btn ghost" data-clear' + (v ? '' : ' hidden') + '>Remove</button>' +
          '<p class="fieldhint" data-status>' + esc(o.hint ||
            (variant === 'portrait'
              ? 'JPEG, PNG, WebP or HEIC. Cropped to passport proportions (35 x 45 mm), ' +
                'resized, and stripped of camera metadata including GPS location.'
              : 'JPEG, PNG, WebP or HEIC. Resized with the aspect ratio kept, and stripped ' +
                'of camera metadata including GPS location.')) + '</p>' +
        '</div>' +
      '</div>';
  }

  /**
   * Document upload — course materials, notebooks, datasets. Unlike a photo
   * this is not re-encoded, so the defence is in how it is served: the download
   * route sends a fixed content type, nosniff, and Content-Disposition:
   * attachment for anything that is not a PDF or a plain image.
   */
  function fileField(prefix, row) {
    var url = String((row && row.fileUrl) || '');
    var nm = String((row && row.fileName) || '');
    var by = row && row.fileBytes ? row.fileBytes : null;

    return '<div class="filefield" data-filefield>' +
      '<input type="hidden" name="' + prefix + '.fileUrl" value="' + esc(url) + '">' +
      '<input type="hidden" name="' + prefix + '.fileName" value="' + esc(nm) + '">' +
      '<input type="hidden" name="' + prefix + '.fileBytes" value="' + esc(by == null ? '' : by) + '">' +
      '<input type="file" hidden data-docfile>' +
      '<div class="filestate" data-filestate>' +
        (url
          ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(nm || 'file') + '</a>' +
            (by ? ' <span class="fsize">' + esc(fmtBytes(by)) + '</span>' : '')
          : '<span class="nofile">No file uploaded</span>') +
      '</div>' +
      '<div class="fileacts">' +
        '<button type="button" class="btn" data-docpick>' +
          (url ? 'Replace file' : 'Upload file') + '</button>' +
        '<button type="button" class="btn ghost" data-docclear' + (url ? '' : ' hidden') + '>Remove</button>' +
      '</div>' +
      '<p class="fieldhint" data-docstatus>PDF, notebook, Office document, CSV, ZIP or image. ' +
        'Up to 64 MB. Leave empty and use the URL field instead to link somewhere else.</p>' +
      '</div>';
  }

  function fmtBytes(n) {
    var b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return Math.round(b / 1024) + ' kB';
    return (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' MB';
  }

  function checkbox(name, label, checked) {
    return '<div class="checkrow"><input type="checkbox" id="f_' + name + '" name="' + name + '"' +
      (checked ? ' checked' : '') + '><label for="f_' + name + '">' + esc(label) + '</label></div>';
  }

  var VIEWS = {

    members: {
      title: 'Members',
      hint: 'Scholars, students and alumni, plus the lab in-charge. Groups appear on the ' +
            'site in the order below; the "Order" number sorts people inside a group. ' +
            'The member in the "Lab in-charge" group supplies the portrait on the Home ' +
            'and Lab In-charge pages rather than appearing as a card.',
      path: '/members',
      groupBy: function (r) { return r.group; },
      groups: MEMBER_GROUPS,
      rowTitle: function (r) { return r.name; },
      rowSub: function (r) { return [r.topic, r.period].filter(Boolean).join(' · '); },
      blank: function () { return { group: 'phd', visible: true, order: 0, links: [] }; },
      form: function (r) {
        return field('name', 'Name', r.name || '', { hint: 'Include the honorific you want shown, e.g. "Ms. Archana Singh".' }) +
          '<div class="two">' +
          field('group', 'Group', r.group || 'phd', { type: 'select', options: MEMBER_GROUPS }) +
          field('order', 'Order', r.order || 0, { type: 'number' }) +
          '</div>' +
          field('topic', 'Topic or dissertation', r.topic || '', { type: 'textarea', rows: 3 }) +
          '<div class="two">' +
          field('period', 'Period', r.period || '', { hint: 'e.g. "Enrolled 2023" or "M.Tech. 2024–2026".' }) +
          field('email', 'Email', r.email || '', { type: 'text' }) +
          '</div>' +
          photoField('photo', 'Photograph', r.photo || '') +
          field('currentPosition', 'Current position', r.currentPosition || '', { hint: 'Alumni only.' }) +
          repeatBlock('links', 'Links', r.links || [], [
            ['label', 'Label'], ['url', 'URL']
          ]) +
          checkbox('visible', 'Show on the public site', r.visible !== false);
      },
      read: function (fd, form) {
        return {
          name: fd.name, group: fd.group, topic: fd.topic, period: fd.period,
          email: fd.email, photo: fd.photo, currentPosition: fd.currentPosition,
          order: Number(fd.order) || 0,
          visible: form.visible.checked,
          links: readRepeat(form, 'links', ['label', 'url']).filter(function (l) { return l.url; })
        };
      }
    },

    research: {
      title: 'Research',
      hint: 'Publications, talks, events and the research directions shown on the home page. ' +
            'Set "Year" so entries sort newest first.',
      path: '/research',
      groupBy: function (r) { return r.kind; },
      groups: RESEARCH_KINDS,
      rowTitle: function (r) { return r.title; },
      rowSub: function (r) { return [r.authors, r.venue, r.date].filter(Boolean).join(' · '); },
      blank: function () { return { kind: 'journal', visible: true, order: 0, tags: [] }; },
      form: function (r) {
        return '<div class="two">' +
          field('kind', 'Kind', r.kind || 'journal', { type: 'select', options: RESEARCH_KINDS }) +
          field('year', 'Year', r.year == null ? '' : r.year, { type: 'number', hint: 'Used for sorting.' }) +
          '</div>' +
          field('title', 'Title', r.title || '', { type: 'textarea', rows: 2 }) +
          field('authors', 'Authors', r.authors || '', { type: 'textarea', rows: 2, hint: 'Exactly as published — the site never reorders them.' }) +
          field('venue', 'Venue', r.venue || '', { type: 'textarea', rows: 2, hint: 'Journal, proceedings, or host institution.' }) +
          '<div class="two">' +
          field('date', 'Date shown', r.date || '', { hint: 'e.g. "2026" or "20–22 Jul 2026".' }) +
          field('detail', 'Detail', r.detail || '', { hint: 'e.g. "vol. 79, pp. 11837–11860".' }) +
          '</div>' +
          '<div class="two">' +
          field('doi', 'DOI', r.doi || '', { hint: 'Number only, no https://doi.org/ prefix.' }) +
          field('url', 'Link', r.url || '') +
          '</div>' +
          field('tags', 'Tags', (r.tags || []).join(', '), { hint: 'Comma separated, e.g. "Scopus, First author".' }) +
          photoField('image', 'Figure', r.image || '', { variant: 'figure',
            hint: 'Optional graphical abstract or result panel, shown under the entry. ' +
                  'The aspect ratio is kept, not cropped square.' }) +
          field('imageCaption', 'Figure caption', r.imageCaption || '') +
          '<div class="two">' +
          field('label', 'Eyebrow label', r.label || '', { hint: 'Research directions only, e.g. "Forensics".' }) +
          field('order', 'Order', r.order || 0, { type: 'number' }) +
          '</div>' +
          field('body', 'Body text', r.body || '', { type: 'textarea', rows: 4, hint: 'Research directions only.' }) +
          checkbox('visible', 'Show on the public site', r.visible !== false);
      },
      read: function (fd, form) {
        return {
          kind: fd.kind, title: fd.title, authors: fd.authors, venue: fd.venue,
          date: fd.date, detail: fd.detail, doi: fd.doi, url: fd.url,
          image: fd.image, imageCaption: fd.imageCaption,
          label: fd.label, body: fd.body,
          year: fd.year === '' ? null : Number(fd.year),
          order: Number(fd.order) || 0,
          tags: String(fd.tags || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
          visible: form.visible.checked
        };
      }
    },

    courses: {
      title: 'Teaching',
      hint: 'One entry per course. Units and materials repeat — add as many rows as you need. ' +
            'Leaving a material\'s URL blank shows "link pending" on the site.',
      path: '/courses',
      rowTitle: function (r) { return r.title; },
      rowSub: function (r) {
        return [r.designation, r.semester, r.level, r.ltp ? 'L-T-P ' + r.ltp : '',
          r.current ? '' : 'past'].filter(Boolean).join(' · ');
      },
      blank: function () {
        return { category: 'Core', current: true, visible: true, order: 0, units: [], resources: [] };
      },
      form: function (r) {
        return '<div class="two">' +
          field('title', 'Course title', r.title || '') +
          field('slug', 'Slug', r.slug || '', { hint: 'Short id, letters and hyphens only, e.g. "dbms".' }) +
          '</div>' +
          '<div class="two">' +
          field('designation', 'Designation', r.designation || '', { hint: 'e.g. "Engg Foundation-I".' }) +
          field('category', 'Category', r.category || 'Core', { type: 'select', options: ['Core', 'Elective', 'Lab', 'Other'] }) +
          '</div>' +
          '<div class="two">' +
          field('semester', 'Semester', r.semester || '', { type: 'select', options: [['', '—'], 'Monsoon', 'Winter', 'Both'] }) +
          field('level', 'Level', r.level || '', { hint: 'e.g. "B.Tech. 1st year".' }) +
          '</div>' +
          '<div class="two">' +
          field('ltp', 'L-T-P', r.ltp || '', { hint: 'e.g. "3-0-2".' }) +
          field('order', 'Order', r.order || 0, { type: 'number' }) +
          '</div>' +
          field('description', 'Description', r.description || '', { type: 'textarea', rows: 4 }) +
          repeatBlock('units', 'Units', r.units || [], [
            ['label', 'Label'], ['title', 'Title'], ['topics', 'Topics', 'textarea']
          ]) +
          repeatBlock('resources', 'Course materials', r.resources || [], [
            ['kind', 'Type'], ['item', 'Item'], ['url', 'External URL (optional)'],
            ['fileUrl', 'Uploaded file', 'file']
          ]) +
          field('reading', 'Reading', r.reading || '', { type: 'textarea', rows: 5, hint: 'One reference per line.' }) +
          checkbox('current', 'Currently teaching this course', r.current !== false) +
          checkbox('visible', 'Show on the public site', r.visible !== false);
      },
      read: function (fd, form) {
        return {
          title: fd.title, slug: String(fd.slug || '').toLowerCase().trim(),
          designation: fd.designation, category: fd.category, semester: fd.semester,
          level: fd.level, ltp: fd.ltp, description: fd.description, reading: fd.reading,
          order: Number(fd.order) || 0,
          current: form.current.checked,
          visible: form.visible.checked,
          units: readRepeat(form, 'units', ['label', 'title', 'topics'])
            .filter(function (u) { return u.title || u.topics; }),
          resources: readRepeat(form, 'resources',
            ['kind', 'item', 'url', 'fileUrl', 'fileName', 'fileBytes'])
            .filter(function (r2) { return r2.item; })
        };
      }
    },

    gallery: {
      title: 'Gallery',
      hint: 'Lab photographs — the group, equipment, events. Leave "Album" blank for a ' +
            'single ungrouped set; fill it in to break the page into sections. The tab ' +
            'is hidden on the public site until there is at least one photograph.',
      path: '/gallery',
      sort: { order: 1 },
      rowTitle: function (r) { return r.caption || '(no caption)'; },
      rowSub: function (r) { return [r.album, r.taken].filter(Boolean).join(' · '); },
      blank: function () { return { visible: true, order: 0, album: '', photo: '' }; },
      form: function (r) {
        return photoField('photo', 'Photograph', r.photo || '', { variant: 'gallery',
          hint: 'Resized to 1600px with the aspect ratio kept, plus a thumbnail for the ' +
                'grid. Camera metadata including GPS location is stripped.' }) +
          field('caption', 'Caption', r.caption || '', { type: 'textarea', rows: 2 }) +
          '<div class="two">' +
          field('album', 'Album', r.album || '', { hint: 'e.g. "FDP 2025". Blank = ungrouped.' }) +
          field('taken', 'When', r.taken || '', { hint: 'e.g. "July 2025".' }) +
          '</div>' +
          field('order', 'Order', r.order || 0, { type: 'number' }) +
          checkbox('visible', 'Show on the public site', r.visible !== false);
      },
      read: function (fd, form) {
        return {
          photo: fd.photo, caption: fd.caption, album: fd.album, taken: fd.taken,
          order: Number(fd.order) || 0,
          visible: form.visible.checked,
        };
      }
    },

    metrics: {
      title: 'Metrics',
      hint: 'The figures in the row on the home page. Leave a field blank and its tile ' +
            'disappears rather than showing a zero.',
      singleton: true
    },

    account: { title: 'Account', hint: 'Change the password for this editor.', account: true }
  };

  // ------------------------------------------- repeating sub-field blocks

  function repeatBlock(name, label, rows, cols) {
    var items = rows.length ? rows : [];
    return '<label>' + esc(label) + '</label><div class="repeat" data-repeat="' + name + '">' +
      '<div data-items>' + items.map(function (row, i) { return repeatItem(name, cols, row, i); }).join('') + '</div>' +
      '<button type="button" class="btn ghost repeat-add" data-add="' + name + '">Add row</button>' +
      '</div>';
  }

  function repeatItem(name, cols, row, i) {
    row = row || {};
    return '<div class="repeat-item" data-row>' +
      '<div class="rhead"><span>' + esc(String(i + 1)) + '</span>' +
      '<button type="button" class="btn ghost" data-remove>Remove</button></div>' +
      cols.map(function (c) {
        var key = c[0], lbl = c[1], type = c[2] || 'text';
        var nm = name + '.' + key;
        if (type === 'file') {
          return '<label>' + esc(lbl) + '</label>' + fileField(name, row);
        }
        if (type === 'textarea') {
          return '<label>' + esc(lbl) + '</label><textarea name="' + nm + '" rows="3">' + esc(row[key] || '') + '</textarea>';
        }
        return '<label>' + esc(lbl) + '</label><input name="' + nm + '" type="text" value="' + esc(row[key] || '') + '">';
      }).join('') +
      '</div>';
  }

  function readRepeat(form, name, keys) {
    var block = form.querySelector('[data-repeat="' + name + '"]');
    if (!block) return [];
    return Array.prototype.slice.call(block.querySelectorAll('[data-row]')).map(function (rowEl) {
      var obj = {};
      keys.forEach(function (k) {
        var input = rowEl.querySelector('[name="' + name + '.' + k + '"]');
        if (!input) { obj[k] = ''; return; }
        var v = input.value.trim();
        // fileBytes is a number on the server; an empty string would fail the
        // schema's Number cast, so send null instead.
        obj[k] = k === 'fileBytes' ? (v === '' ? null : Number(v)) : v;
      });
      return obj;
    });
  }

  // Delegated handlers for the repeat blocks — the rows are rebuilt on every
  // dialog open, so binding per row would leak listeners.
  document.addEventListener('click', function (e) {
    var rm = e.target.closest ? e.target.closest('[data-remove]') : null;
    if (rm) {
      e.preventDefault();
      var row = rm.closest('[data-row]');
      if (row) row.remove();
      return;
    }
    var add = e.target.closest ? e.target.closest('[data-add]') : null;
    if (add) {
      e.preventDefault();
      var nm = add.getAttribute('data-add');
      var block = add.closest('[data-repeat]');
      var items = block.querySelector('[data-items]');
      var cols = REPEAT_COLS[nm];
      var n = items.querySelectorAll('[data-row]').length;
      items.insertAdjacentHTML('beforeend', repeatItem(nm, cols, {}, n));
    }
  });

  // Photo field: pick, upload, clear. Delegated because the dialog rebuilds its
  // contents on every open.
  document.addEventListener('click', function (e) {
    var pick = e.target.closest ? e.target.closest('[data-pick]') : null;
    if (pick) {
      e.preventDefault();
      var f = pick.closest('[data-photofield]').querySelector('[data-file]');
      f.value = '';
      f.click();
      return;
    }
    var clear = e.target.closest ? e.target.closest('[data-clear]') : null;
    if (clear) {
      e.preventDefault();
      var box = clear.closest('[data-photofield]');
      box.querySelector('input[type=hidden]').value = '';
      box.querySelector('[data-preview]').innerHTML = '<span>No photo</span>';
      box.querySelector('[data-pick]').textContent = 'Upload photo';
      clear.hidden = true;
      box.querySelector('[data-status]').textContent = 'Photo removed. Save to apply.';
    }
  });

  document.addEventListener('change', async function (e) {
    var input = e.target;
    if (!input.matches || !input.matches('[data-file]')) return;

    var file = input.files && input.files[0];
    if (!file) return;

    var box = input.closest('[data-photofield]');
    var status = box.querySelector('[data-status]');
    var pickBtn = box.querySelector('[data-pick]');

    // Check the size here so an obviously oversized file is refused instantly
    // rather than after a slow upload that the server will reject anyway.
    var MAX = 12 * 1024 * 1024;
    if (file.size > MAX) {
      status.textContent = 'That image is ' + (file.size / 1048576).toFixed(1) +
        ' MB — the limit is 12 MB.';
      status.className = 'fieldhint bad';
      return;
    }

    status.textContent = 'Uploading and processing\u2026';
    status.className = 'fieldhint';
    pickBtn.disabled = true;

    try {
      var body = new FormData();
      body.append('photo', file);
      body.append('variant', box.getAttribute('data-variant') || 'portrait');

      // Not the api() helper: that sets a JSON content type, and a multipart
      // body needs the browser to set it with the boundary.
      var res = await fetch('/api/photos', {
        method: 'POST', body: body, credentials: 'same-origin'
      });

      if (res.status === 401) { showGate(); throw new Error('Your session ended.'); }

      var data = null;
      try { data = await res.json(); } catch (ex) { /* empty body */ }
      if (!res.ok) throw new Error((data && data.error) || 'Upload failed (HTTP ' + res.status + ')');

      box.querySelector('input[type=hidden]').value = data.url;
      box.querySelector('[data-preview]').innerHTML =
        '<img src="' + esc(data.url) + '?t=' + Date.now() + '" alt="">';
      pickBtn.textContent = 'Replace photo';
      box.querySelector('[data-clear]').hidden = false;

      var from = Math.round((data.originalBytes || 0) / 1024);
      var to = Math.round((data.bytes || 0) / 1024);
      status.textContent = 'Uploaded. ' + from + ' kB \u2192 ' + to + ' kB, ' +
        data.width + '\u00d7' + data.height + ', metadata stripped. Save to apply.';
    } catch (ex) {
      status.textContent = ex.message;
      status.className = 'fieldhint bad';
    } finally {
      pickBtn.disabled = false;
      input.value = '';
    }
  });

  // Document upload inside a repeating row.
  document.addEventListener('click', function (e) {
    var pick = e.target.closest ? e.target.closest('[data-docpick]') : null;
    if (pick) {
      e.preventDefault();
      var f = pick.closest('[data-filefield]').querySelector('[data-docfile]');
      f.value = '';
      f.click();
      return;
    }
    var clr = e.target.closest ? e.target.closest('[data-docclear]') : null;
    if (clr) {
      e.preventDefault();
      var box = clr.closest('[data-filefield]');
      box.querySelectorAll('input[type=hidden]').forEach(function (i) { i.value = ''; });
      box.querySelector('[data-filestate]').innerHTML = '<span class="nofile">No file uploaded</span>';
      box.querySelector('[data-docpick]').textContent = 'Upload file';
      clr.hidden = true;
      box.querySelector('[data-docstatus]').textContent = 'File removed. Save to apply.';
    }
  });

  document.addEventListener('change', async function (e) {
    var input = e.target;
    if (!input.matches || !input.matches('[data-docfile]')) return;
    var file = input.files && input.files[0];
    if (!file) return;

    var box = input.closest('[data-filefield]');
    var status = box.querySelector('[data-docstatus]');
    var btn = box.querySelector('[data-docpick]');

    var MAX = 64 * 1024 * 1024;
    if (file.size > MAX) {
      status.textContent = 'That file is ' + fmtBytes(file.size) + ' — the limit is 64 MB.';
      status.className = 'fieldhint bad';
      return;
    }

    status.textContent = 'Uploading ' + fmtBytes(file.size) + '\u2026';
    status.className = 'fieldhint';
    btn.disabled = true;

    try {
      var body = new FormData();
      body.append('file', file);
      var res = await fetch('/api/files', { method: 'POST', body: body, credentials: 'same-origin' });
      if (res.status === 401) { showGate(); throw new Error('Your session ended.'); }

      var data = null;
      try { data = await res.json(); } catch (ex) {}
      if (!res.ok) throw new Error((data && data.error) || 'Upload failed (HTTP ' + res.status + ')');

      box.querySelector('[name$=".fileUrl"]').value = data.url;
      box.querySelector('[name$=".fileName"]').value = data.filename;
      box.querySelector('[name$=".fileBytes"]').value = String(data.bytes);
      box.querySelector('[data-filestate]').innerHTML =
        '<a href="' + esc(data.url) + '" target="_blank" rel="noopener">' + esc(data.filename) + '</a>' +
        ' <span class="fsize">' + esc(fmtBytes(data.bytes)) + '</span>';
      btn.textContent = 'Replace file';
      box.querySelector('[data-docclear]').hidden = false;

      var msg = 'Uploaded. Save to apply.';
      // Warn well before a free cluster's 512 MB ceiling, where the failure
      // would otherwise appear as an unexplained write error.
      if (data.quota && data.quota.storageBytes) {
        var usedMb = data.quota.storageBytes / 1048576;
        if (usedMb > 380) {
          msg += ' Storage is at ' + usedMb.toFixed(0) + ' MB of a 512 MB free-tier cluster — ' +
                 'consider linking large files instead of uploading them.';
          status.className = 'fieldhint bad';
        }
      }
      status.textContent = msg;
    } catch (ex) {
      status.textContent = ex.message;
      status.className = 'fieldhint bad';
    } finally {
      btn.disabled = false;
      input.value = '';
    }
  });

  var REPEAT_COLS = {
    links: [['label', 'Label'], ['url', 'URL']],
    units: [['label', 'Label'], ['title', 'Title'], ['topics', 'Topics', 'textarea']],
    resources: [['kind', 'Type'], ['item', 'Item'], ['url', 'External URL (optional)'],
                ['fileUrl', 'Uploaded file', 'file']]
  };

  // ------------------------------------------------------------- listing

  var current = 'members';
  var cache = [];

  function switchView(name) {
    current = name;
    var v = VIEWS[name];

    Array.prototype.slice.call(document.querySelectorAll('[data-view]')).forEach(function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-view') === name ? 'true' : 'false');
    });

    el('view-title').textContent = v.title;
    el('view-hint').textContent = v.hint || '';
    el('new-btn').hidden = Boolean(v.singleton || v.account);

    if (v.account) return renderAccount();
    if (v.singleton) return renderMetrics();
    loadList();
  }

  Array.prototype.slice.call(document.querySelectorAll('[data-view]')).forEach(function (b) {
    b.addEventListener('click', function () { switchView(b.getAttribute('data-view')); });
  });

  async function loadList() {
    var v = VIEWS[current];
    el('list').innerHTML = '<p class="emptyish">Loading…</p>';
    try {
      cache = await api('GET', v.path);
      renderList();
    } catch (ex) {
      el('list').innerHTML = '<div class="msg err">' + esc(ex.message) + '</div>';
    }
  }

  function rowHtml(v, r) {
    return '<div class="rowitem' + (r.visible === false ? ' hiddenrow' : '') + '">' +
      '<span class="ord">' + esc(r.order == null ? '' : r.order) + '</span>' +
      '<div class="main"><div class="rtitle">' + esc(v.rowTitle(r)) + '</div>' +
      '<div class="rsub">' + esc(v.rowSub(r) || '—') + '</div></div>' +
      '<div class="acts"><button class="btn ghost" data-edit="' + esc(r._id) + '">Edit</button></div>' +
      '</div>';
  }

  function renderList() {
    var v = VIEWS[current];
    var box = el('list');

    if (!cache.length) {
      box.innerHTML = '<p class="emptyish">Nothing here yet. Use <b>Add</b> to create the first entry.</p>';
      return;
    }

    var html = '';
    if (v.groups) {
      var seen = {};
      v.groups.forEach(function (g) {
        var key = g[0], label = g[1];
        var rows = cache.filter(function (r) { return v.groupBy(r) === key; });
        rows.forEach(function (r) { seen[r._id] = true; });
        if (!rows.length) return;
        html += '<p class="group-head">' + esc(label) + ' &middot; ' + rows.length + '</p>' +
          '<div class="rowlist">' + rows.map(function (r) { return rowHtml(v, r); }).join('') + '</div>';
      });
      var rest = cache.filter(function (r) { return !seen[r._id]; });
      if (rest.length) {
        html += '<p class="group-head">Other &middot; ' + rest.length + '</p>' +
          '<div class="rowlist">' + rest.map(function (r) { return rowHtml(v, r); }).join('') + '</div>';
      }
    } else {
      html = '<div class="rowlist" style="margin-top:1.4rem">' +
        cache.map(function (r) { return rowHtml(v, r); }).join('') + '</div>';
    }

    box.innerHTML = html;

    Array.prototype.slice.call(box.querySelectorAll('[data-edit]')).forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-edit');
        openModal(cache.filter(function (r) { return String(r._id) === id; })[0]);
      });
    });
  }

  el('new-btn').addEventListener('click', function () { openModal(null); });

  // --------------------------------------------------------------- modal

  var editing = null;

  function openModal(record) {
    var v = VIEWS[current];
    editing = record;

    el('modal-title').textContent = record ? 'Edit entry' : 'New entry';
    el('edit-form').innerHTML = v.form(record || v.blank());
    el('delete-btn').hidden = !record;
    el('modal').hidden = false;

    var first = el('edit-form').querySelector('input, select, textarea');
    if (first) first.focus();
  }

  function closeModal() {
    el('modal').hidden = true;
    editing = null;
  }

  el('modal-close').addEventListener('click', closeModal);
  el('cancel-btn').addEventListener('click', closeModal);
  el('modal').addEventListener('click', function (e) {
    if (e.target === el('modal')) closeModal();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el('modal').hidden) closeModal();
  });

  el('save-btn').addEventListener('click', async function () {
    var v = VIEWS[current];
    var form = el('edit-form');
    var fd = {};
    Array.prototype.slice.call(form.elements).forEach(function (input) {
      if (!input.name || input.name.indexOf('.') !== -1) return;
      fd[input.name] = input.type === 'checkbox' ? input.checked : input.value.trim();
    });

    var payload = v.read(fd, form);
    var btn = el('save-btn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
      if (editing) {
        await api('PUT', v.path + '/' + editing._id, payload);
      } else {
        await api('POST', v.path, payload);
      }
      closeModal();
      toast('Saved. The public site is updated.');
      loadList();
    } catch (ex) {
      toast(ex.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  });

  el('delete-btn').addEventListener('click', async function () {
    if (!editing) return;
    var v = VIEWS[current];
    var name = v.rowTitle(editing);
    if (!window.confirm('Delete "' + name + '"? This cannot be undone.')) return;

    try {
      await api('DELETE', v.path + '/' + editing._id);
      closeModal();
      toast('Deleted.');
      loadList();
    } catch (ex) {
      toast(ex.message, true);
    }
  });

  // ------------------------------------------------------------- metrics

  async function renderMetrics() {
    var box = el('list');
    box.innerHTML = '<p class="emptyish">Loading…</p>';

    var m;
    try {
      m = await api('GET', '/metrics');
    } catch (ex) {
      box.innerHTML = '<div class="msg err">' + esc(ex.message) + '</div>';
      return;
    }

    box.innerHTML =
      '<form id="metrics-form" style="max-width:560px;margin-top:1.5rem">' +
      '<div class="two">' +
      field('citations', 'Citations', m.citations == null ? '' : m.citations, { type: 'number', min: 0 }) +
      field('hIndex', 'h-index', m.hIndex == null ? '' : m.hIndex, { type: 'number', min: 0 }) +
      '</div>' +
      '<div class="two">' +
      field('i10Index', 'i10-index', m.i10Index == null ? '' : m.i10Index, { type: 'number', min: 0 }) +
      field('phdScholars', 'Ph.D. scholars', m.phdScholars == null ? '' : m.phdScholars, { type: 'number', min: 0 }) +
      '</div>' +
      '<div class="two">' +
      field('mtechSupervised', 'M.Tech. supervised', m.mtechSupervised == null ? '' : m.mtechSupervised, { type: 'number', min: 0 }) +
      field('patents', 'Granted patents', m.patents == null ? '' : m.patents, { type: 'number', min: 0 }) +
      '</div>' +
      field('asOf', 'As of', m.asOf || '', { hint: 'e.g. "September 2026". Printed next to the figures.' }) +
      field('source', 'Source', m.source || '', { hint: 'Whoever the numbers actually came from — Google Scholar, OpenAlex, Scopus. The site prints this, so the figures are never credited to the wrong source.' }) +
      field('profileUrl', 'Profile URL', m.profileUrl || '') +
      '<button type="submit" class="btn primary" style="margin-top:1.5rem">Save metrics</button>' +
      '</form>';

    el('metrics-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var f = e.target;
      var btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        await api('PUT', '/metrics', {
          citations: f.citations.value, hIndex: f.hIndex.value, i10Index: f.i10Index.value,
          phdScholars: f.phdScholars.value, mtechSupervised: f.mtechSupervised.value,
          patents: f.patents.value,
          asOf: f.asOf.value, source: f.source.value, profileUrl: f.profileUrl.value
        });
        toast('Metrics saved.');
      } catch (ex) {
        toast(ex.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save metrics';
      }
    });
  }

  // ------------------------------------------------------------- account

  function renderAccount() {
    el('list').innerHTML =
      '<form id="pw-form" style="max-width:420px;margin-top:1.5rem">' +
      field('currentPassword', 'Current password', '', { type: 'password' }) +
      field('newPassword', 'New password', '', { type: 'password', hint: 'At least 12 characters.' }) +
      field('confirmPassword', 'Confirm new password', '', { type: 'password' }) +
      '<button type="submit" class="btn primary" style="margin-top:1.5rem">Change password</button>' +
      '<p class="fieldhint" style="margin-top:1rem">Changing the password signs out every other ' +
      'browser where this account is open.</p>' +
      '</form>' +
      '<form id="out-form" style="margin-top:2.5rem">' +
      '<button type="submit" class="btn ghost">Sign out</button></form>';

    el('pw-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var f = e.target;
      if (f.newPassword.value !== f.confirmPassword.value) {
        return toast('The two new passwords do not match.', true);
      }
      var btn = f.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        var out = await api('POST', '/auth/change-password', {
          currentPassword: f.currentPassword.value,
          newPassword: f.newPassword.value
        });
        f.reset();
        toast(out.message || 'Password changed.');
      } catch (ex) {
        toast(ex.message, true);
      } finally {
        btn.disabled = false;
      }
    });

    el('out-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      try { await api('POST', '/auth/logout'); } catch (ex) { /* going anyway */ }
      showGate();
    });
  }

  // ---------------------------------------------------------------- boot

  api('GET', '/auth/me')
    .then(function () { showApp(); switchView('members'); })
    .catch(function () { showGate(); });
})();
