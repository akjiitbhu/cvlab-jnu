/* Computing and Vision Lab — public site.
 *
 * Static shell, dynamic content: the tab router runs immediately so navigation
 * works before any data arrives, then one GET /api/content fills the metrics
 * row, research directions, publications, members and courses.
 *
 * Every value that comes out of the database is escaped before it reaches
 * innerHTML. The admin is the only writer, but "the only writer is trusted" is
 * not a security model — a single missed escape turns one bad paste into a
 * persistent script on every visitor's page.
 */
(function () {
  'use strict';

  // ------------------------------------------------------------ helpers

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** Only http(s), mailto and site-relative hrefs. Blocks javascript: URLs. */
  function safeUrl(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (/^(https?:\/\/|mailto:|\/|#)/i.test(s)) return esc(s);
    if (/^[\w.-]+@[\w.-]+\.\w+$/.test(s)) return 'mailto:' + esc(s);
    if (/^[\w.-]+\.\w{2,}(\/|$)/.test(s)) return 'https://' + esc(s);
    return '';
  }

  function el(id) { return document.getElementById(id); }

  function fmtBytes(n) {
    var b = Number(n) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return Math.round(b / 1024) + ' kB';
    return (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' MB';
  }

  // ------------------------------------------------------------- api base
  //
  // The pages are static files that may be served from GitHub Pages while the
  // API runs on a different host, so requests are not necessarily same-origin.
  // assets/config.js sets this; an empty value means same origin.
  var CFG = window.CVLAB_CONFIG || {};
  var API_BASE = String(CFG.API_BASE || '').replace(/\/+$/, '');
  var RETRIES = CFG.COLD_START_RETRIES == null ? 4 : Number(CFG.COLD_START_RETRIES);
  var RETRY_DELAY = CFG.COLD_START_DELAY_MS == null ? 4000 : Number(CFG.COLD_START_DELAY_MS);

  function apiUrl(path) { return API_BASE + path; }

  /**
   * Resolve a stored photo reference.
   *
   * Uploaded photos are stored as "/api/photos/<id>" — root-relative, so the
   * value is the same wherever the site runs. But on GitHub Pages that path
   * would resolve against github.io, which serves no API and has no photos, so
   * every portrait would 404. Anything root-relative therefore gets the API
   * base prepended; an absolute URL (someone pasting a link to a photo hosted
   * elsewhere) is left alone.
   */
  function mediaUrl(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return '';
    if (/^https?:\/\//i.test(s)) return safeUrl(s);
    if (s.charAt(0) === '/') return safeUrl(apiUrl(s));
    return safeUrl(s);
  }

  // The editor lives on the API host, not on the static site, so that its login
  // stays same-origin with the API it calls.
  var adminLink = el('adminlink');
  if (adminLink) adminLink.setAttribute('href', apiUrl('/admin'));
  function nl2list(text) {
    return String(text || '').split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function fail(node, what) {
    if (!node) return;
    node.innerHTML =
      '<div class="state err"><b>' + esc(what) + ' could not be loaded.</b> ' +
      'The site is running but could not reach its database. ' +
      'If this persists, the server may be starting up — reload in a moment.</div>';
  }

  function emptyState(node, msg) {
    if (node) node.innerHTML = '<p class="state">' + esc(msg) + '</p>';
  }

  /* Free API hosts sleep when idle. The first request wakes the process, which
     can take most of a minute, so say that plainly instead of showing an error
     the reader can do nothing about. */
  function waking(node, attempt, total) {
    if (!node) return;
    node.innerHTML =
      '<div class="state err"><b>Waking the server\u2026</b> ' +
      'This site\u2019s database host sleeps when nobody has visited for a while, and ' +
      'takes up to a minute to start. Retrying (' + attempt + ' of ' + total + ').</div>';
  }

  var SECTION_NODES = function () {
    return [
      { node: el('research-body'), label: 'Publications' },
      { node: el('members-body'), label: 'Members' },
      { node: el('teaching-body'), label: 'Courses' }
    ];
  };

  // ------------------------------------------------------- tab routing

  var tabs = Array.prototype.slice.call(document.querySelectorAll('nav.tabs [role="tab"]'));
  var pages = {};
  tabs.forEach(function (t) {
    pages[t.id.replace('tab-', '')] = document.getElementById(t.getAttribute('aria-controls'));
  });

  function show(key, push) {
    if (!pages[key]) key = 'home';
    tabs.forEach(function (t) {
      var k = t.id.replace('tab-', '');
      var on = k === key;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      if (pages[k]) pages[k].hidden = !on;
    });
    if (push !== false && location.hash !== '#' + key) {
      history.replaceState(null, '', '#' + key);
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  tabs.forEach(function (t) {
    t.addEventListener('click', function () { show(t.id.replace('tab-', '')); });
    t.addEventListener('keydown', function (e) {
      var i = tabs.indexOf(t), n = null;
      if (e.key === 'ArrowRight') n = tabs[(i + 1) % tabs.length];
      if (e.key === 'ArrowLeft') n = tabs[(i - 1 + tabs.length) % tabs.length];
      if (n) { e.preventDefault(); n.focus(); n.click(); }
    });
  });

  document.addEventListener('click', function (e) {
    var a = e.target.closest ? e.target.closest('[data-nav]') : null;
    if (a) { e.preventDefault(); show(a.getAttribute('data-nav')); }
  });

  var initial = (location.hash || '#home').slice(1);
  show(pages[initial] ? initial : 'home', false);

  // ---------------------------------------------------------- metrics

  var METRIC_TILES = [
    { key: 'citations', label: 'Citations' },
    { key: 'hIndex', label: 'h-index' },
    { key: 'i10Index', label: 'i10-index' },
    { key: 'phdScholars', label: 'Ph.D. scholars', pad: true },
    { key: 'mtechSupervised', label: 'M.Tech. supervised', pad: true },
    { key: 'patents', label: 'Granted patent', pad: true }
  ];

  /** document.querySelectorAll as a real array iteration. */
  function each(selector, fn) {
    Array.prototype.forEach.call(document.querySelectorAll(selector), fn);
  }

  /**
   * Fill every metrics strip on the page.
   *
   * There is more than one — the Home hero and the Lab In-charge profile both
   * carry the same figures — so this selects on an attribute rather than an id.
   * getElementById returns the first match only, which is why the second strip
   * silently stayed on its em-dash placeholders.
   */
  function renderMetrics(m) {
    var boxes = document.querySelectorAll('[data-metrics]');
    if (!boxes.length) return;

    var html = '';
    if (m) {
      METRIC_TILES.forEach(function (t) {
        var v = m[t.key];
        if (v === null || v === undefined || v === '') return;  // tile omitted
        var shown = t.pad && Number(v) < 10 ? '0' + Number(v) : String(v);
        html += '<div><b>' + esc(shown) + '</b><small>' + esc(t.label) + '</small></div>';
      });
    }

    Array.prototype.forEach.call(boxes, function (box) { box.innerHTML = html; });

    // The attribution line follows the figures: shown only where there is both
    // something to attribute and a source to name.
    var show = !!m && html !== '' && !!(m.source || m.asOf);
    var url = m ? safeUrl(m.profileUrl) : '';

    each('[data-srcline]', function (line) { line.hidden = !show; });
    each('[data-src-link]', function (link) {
      if (m && m.source) link.textContent = m.source;
      if (url) link.setAttribute('href', url);
    });
    each('[data-m="asOf"]', function (node) {
      node.textContent = (m && m.asOf) || '—';
    });
  }

  // ------------------------------------------------- research themes

  function renderThemes(themes) {
    var box = el('themes');
    if (!box) return;
    if (!themes || !themes.length) { box.style.display = 'none'; return; }

    box.innerHTML = themes.map(function (t) {
      return '<article class="theme">' +
        (t.label ? '<span class="tag">' + esc(t.label) + '</span>' : '') +
        '<h3>' + esc(t.title) + '</h3>' +
        (t.body ? '<p>' + esc(t.body) + '</p>' : '') +
        '</article>';
    }).join('');
  }

  // ------------------------------------------------- lab in-charge

  /**
   * Fill the two portrait frames on the Home and Lab In-charge pages from the
   * member record whose group is "pi". Left as the "to be added" placeholder
   * when there is no record or no photograph, which is the honest state.
   */
  function renderPi(pi) {
    var frames = document.querySelectorAll('[data-pi-portrait]');
    if (!frames.length) return;

    var photo = pi ? mediaUrl(pi.photo) : '';

    Array.prototype.forEach.call(frames, function (frame) {
      if (!photo) return;                      // keep the placeholder text
      frame.innerHTML =
        '<img src="' + photo + '" alt="' + esc(pi.name || '') + '" ' +
        'width="140" height="180" class="portrait-img">';
      frame.classList.add('has-photo');
    });
  }

  // -------------------------------------------------------- research

  var RESEARCH_GROUPS = [
    { kind: 'patent', id: 'r-patent', rail: 'Patent', head: 'Granted patent', style: 'plain' },
    { kind: 'journal', id: 'r-journals', rail: 'Journals', head: 'Peer-reviewed journals', style: 'numbered' },
    { kind: 'chapter', id: 'r-chapters', rail: 'Book chapters', head: 'Book chapters', style: 'numbered' },
    { kind: 'conference', id: 'r-conf', rail: 'Conferences', head: 'Conference publications', style: 'numbered' },
    { kind: 'talk', id: 'r-talks', rail: 'Invited talks', head: 'Invited talks', style: 'timeline' },
    { kind: 'organized', id: 'r-organized', rail: 'Organized', head: 'Events organized', style: 'plain' },
    { kind: 'chaired', id: 'r-chaired', rail: 'Chaired', head: 'Conferences chaired', style: 'plain' }
  ];

  function citation(item) {
    var out = '';
    if (item.authors) out += esc(item.authors) + '. ';
    out += '<span class="t">' + esc(item.title) + '</span>';
    if (item.venue) out += ' <span class="v">' + esc(item.venue) + '</span>';
    if (item.detail) out += ', ' + esc(item.detail);
    if (item.date) out += ', ' + esc(item.date);
    out += '.';

    var chips = [];
    (item.tags || []).forEach(function (tag) {
      var cls = 'chip';
      if (/^first/i.test(tag)) cls += ' first';
      if (/best/i.test(tag)) cls += ' award';
      chips.push('<span class="' + cls + '">' + esc(tag) + '</span>');
    });
    if (item.doi) {
      var d = String(item.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
      chips.push('<a class="chip doi" href="https://doi.org/' + esc(encodeURIComponent(d).replace(/%2F/g, '/')) + '">' + esc(d) + '</a>');
    }
    var u = safeUrl(item.url);
    if (u) chips.push('<a class="chip" href="' + u + '">Link</a>');

    if (chips.length) out += '<span class="meta">' + chips.join('') + '</span>';

    var fig = mediaUrl(item.image);
    if (fig) {
      out += '<figure class="pubfig">' +
        '<img src="' + fig + '" alt="' + esc(item.imageCaption || '') + '" loading="lazy">' +
        (item.imageCaption ? '<figcaption>' + esc(item.imageCaption) + '</figcaption>' : '') +
        '</figure>';
    }
    return out;
  }

  function renderResearch(byKind) {
    var body = el('research-body');
    var rail = el('research-rail');
    if (!body) return;

    var present = RESEARCH_GROUPS.filter(function (g) {
      return (byKind[g.kind] || []).length > 0;
    });

    if (!present.length) {
      emptyState(body, 'No research items recorded yet.');
      if (rail) rail.innerHTML = '';
      return;
    }

    var counts = {};
    RESEARCH_GROUPS.forEach(function (g) { counts[g.kind] = (byKind[g.kind] || []).length; });

    var summary = [];
    if (counts.patent) summary.push(counts.patent + (counts.patent === 1 ? ' granted patent' : ' granted patents'));
    if (counts.journal) summary.push(counts.journal + ' peer-reviewed journal ' + (counts.journal === 1 ? 'article' : 'articles'));
    if (counts.chapter) summary.push(counts.chapter + ' book ' + (counts.chapter === 1 ? 'chapter' : 'chapters'));
    if (counts.conference) summary.push(counts.conference + ' conference ' + (counts.conference === 1 ? 'paper' : 'papers'));

    var html = '<section class="blk" id="r-top">' +
      '<p class="eyebrow">Research output</p>' +
      '<h2 style="font-size:1.9rem">Publications and scholarly activity</h2>' +
      (summary.length
        ? '<p class="lede" style="margin-top:.9rem">' + esc(summary.join(', ')) + '.</p>'
        : '') +
      '</section>';

    present.forEach(function (g) {
      var items = byKind[g.kind];
      html += '<section class="blk" id="' + g.id + '"><h2>' + esc(g.head) + '</h2>';

      if (g.style === 'numbered') {
        html += '<ol class="pubs">' + items.map(function (i) {
          return '<li>' + citation(i) + '</li>';
        }).join('') + '</ol>';

      } else if (g.style === 'timeline') {
        html += '<div class="tl">' + items.map(function (i) {
          return '<div class="tl-item"><div><h3>' + esc(i.title) + '</h3>' +
            (i.venue ? '<p class="org">' + esc(i.venue) + '</p>' : '') +
            '</div><div class="when">' + esc(i.date || '') + '</div></div>';
        }).join('') + '</div>';

      } else {
        html += '<ul class="plain">' + items.map(function (i) {
          var s = '<b>' + esc(i.title) + '</b>';
          if (i.authors) s = esc(i.authors) + ', ' + s;
          if (i.venue) s += ' — ' + esc(i.venue);
          if (i.date) s += ', ' + esc(i.date);
          if (i.detail) s += '. ' + esc(i.detail);
          return '<li>' + s + '</li>';
        }).join('') + '</ul>';
      }

      html += '</section>';
    });

    body.innerHTML = html;

    if (rail) {
      rail.innerHTML = present.map(function (g) {
        return '<a href="#' + g.id + '">' + esc(g.rail) + '</a>';
      }).join('');
    }
  }

  // --------------------------------------------------------- members

  var MEMBER_GROUPS = [
    { key: 'phd', head: 'Ph.D. scholars', unit: 'scholar' },
    { key: 'mtech', head: 'M.Tech. students', unit: 'student' },
    { key: 'btech', head: 'B.Tech. project students', unit: 'student' },
    { key: 'staff', head: 'Staff', unit: 'member' },
    { key: 'alumni', head: 'Alumni', unit: 'alumnus', table: true }
  ];

  function memberCard(m) {
    var links = (m.links || []).map(function (l) {
      var u = safeUrl(l.url);
      return u ? '<a class="chip" href="' + u + '">' + esc(l.label || 'Link') + '</a>' : '';
    }).filter(Boolean);

    if (m.email) {
      links.unshift('<a class="chip" href="mailto:' + esc(m.email) + '">Email</a>');
    }

    var photo = mediaUrl(m.photo);
    var avatar = photo
      ? '<img class="avatar" src="' + photo + '" alt="" width="40" height="40" loading="lazy">'
      : '<span class="avatar">' + esc(m.initials || '?') + '</span>';

    return '<article class="person">' +
      avatar +
      '<h3>' + esc(m.name) + '</h3>' +
      (m.topic ? '<p class="topic">' + esc(m.topic) + '</p>' : '') +
      (m.period ? '<span class="yr">' + esc(m.period) + '</span>' : '') +
      (links.length ? '<span class="meta">' + links.join('') + '</span>' : '') +
      '</article>';
  }

  function alumniTable(rows) {
    return '<div class="tablewrap" style="margin-top:1.2rem"><table>' +
      '<thead><tr><th style="width:26%">Name</th><th>Work</th>' +
      '<th style="width:16%">Period</th><th style="width:24%">Now</th></tr></thead><tbody>' +
      rows.map(function (m) {
        return '<tr><td>' + esc(m.name) + '</td>' +
          '<td>' + esc(m.topic || '') + '</td>' +
          '<td>' + esc(m.period || '') + '</td>' +
          '<td>' + (m.currentPosition
            ? esc(m.currentPosition)
            : '<span class="pending">not recorded</span>') + '</td></tr>';
      }).join('') +
      '</tbody></table></div>';
  }

  function renderMembers(byGroup) {
    var body = el('members-body');
    if (!body) return;

    var present = MEMBER_GROUPS.filter(function (g) { return (byGroup[g.key] || []).length > 0; });

    if (!present.length) {
      emptyState(body, 'No members recorded yet.');
      return;
    }

    var html = present.map(function (g) {
      var rows = byGroup[g.key];
      var n = rows.length;
      return '<div class="cohort">' +
        '<div class="cohort-head"><h2>' + esc(g.head) + '</h2>' +
        '<span class="count">' + n + ' ' + esc(g.unit) + (n === 1 ? '' : 's') + '</span></div>' +
        (g.table
          ? alumniTable(rows)
          : '<div class="people">' + rows.map(memberCard).join('') + '</div>') +
        '</div>';
    }).join('');

    html += '<div class="cohort">' +
      '<div class="cohort-head"><h2>Join the lab</h2><span class="count">Open enquiries</span></div>' +
      '<div class="prose" style="margin-top:1.2rem">' +
      '<p>Students interested in digital image forensics, deepfake detection, source device ' +
      'identification, or applied computer vision are welcome to write to ' +
      '<a href="mailto:ankitjaiswal@jnu.ac.in">ankitjaiswal@jnu.ac.in</a> with a short statement of ' +
      'interest, a CV, and any prior project or coursework in image processing or machine learning.</p>' +
      '</div></div>';

    body.innerHTML = html;

    var lede = el('members-lede');
    if (lede) {
      var bits = [];
      MEMBER_GROUPS.forEach(function (g) {
        var n = (byGroup[g.key] || []).length;
        if (n && g.key !== 'alumni') bits.push(n + ' ' + g.unit + (n === 1 ? '' : 's'));
      });
      var alum = (byGroup.alumni || []).length;
      var text = bits.length ? bits.join(', ') + ' currently in the lab' : '';
      if (alum) text += (text ? ', with ' : '') + alum + ' alumni';
      if (text) lede.textContent = text.charAt(0).toUpperCase() + text.slice(1) + '.';
    }
  }

  // --------------------------------------------------------- courses

  function coursePanel(c, hidden) {
    var sub = [c.designation, c.semester ? c.semester + ' semester' : '', c.level,
      c.ltp ? 'L-T-P ' + c.ltp : '']
      .filter(Boolean).map(esc).join(' &middot; ');

    var html = '<article class="course" data-panel="' + esc(c.slug) + '"' + (hidden ? ' hidden' : '') + '>' +
      '<h2>' + esc(c.title) + '</h2>' +
      (sub ? '<p class="csub">' + sub + '</p>' : '') +
      (c.description ? '<p class="cdesc">' + esc(c.description) + '</p>' : '');

    if ((c.units || []).length) {
      html += '<h3 class="subhead">Unit-wise outline</h3><div class="units">' +
        c.units.map(function (u, i) {
          return '<div class="unit"><span class="n">' +
            esc(u.label || 'Unit ' + (i + 1)) + '</span><div>' +
            '<h4>' + esc(u.title || '') + '</h4>' +
            (u.topics ? '<p>' + esc(u.topics) + '</p>' : '') +
            '</div></div>';
        }).join('') + '</div>';
    }

    if ((c.resources || []).length) {
      html += '<h3 class="subhead">Course materials</h3><div class="tablewrap"><table>' +
        '<thead><tr><th style="width:15%">Type</th><th>Item</th><th style="width:22%">Access</th></tr></thead><tbody>' +
        c.resources.map(function (r) {
          var file = mediaUrl(r.fileUrl);
          var link = safeUrl(r.url);
          var access;

          if (file) {
            // An uploaded file wins over an external link, and its size is
            // worth showing: a student on a phone connection wants to know
            // whether this is 200 kB or 40 MB before tapping it.
            access = '<a href="' + file + '" download>Download</a>' +
              (r.fileBytes ? ' <span class="fsize">' + esc(fmtBytes(r.fileBytes)) + '</span>' : '');
          } else if (link) {
            access = '<a href="' + link + '">Open</a>';
          } else {
            access = '<span class="pending">link pending</span>';
          }

          return '<tr><td><span class="kind">' + esc(r.kind || '') + '</span></td>' +
            '<td>' + esc(r.item || '') + '</td>' +
            '<td>' + access + '</td></tr>';
        }).join('') +
        '</tbody></table></div>';
    }

    var reading = nl2list(c.reading);
    if (reading.length) {
      html += '<h3 class="subhead">Reading</h3><ul class="plain">' +
        reading.map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ul>';
    }

    return html + '</article>';
  }

  function renderCourses(courses) {
    var wrap = el('teaching-body');
    var picker = el('course-picker');
    var panels = el('course-panels');
    if (!wrap || !picker || !panels) return;

    if (!courses || !courses.length) {
      wrap.innerHTML = '<p class="state">No courses recorded yet.</p>';
      return;
    }

    // Current courses first, previously-taught after — order within each group
    // comes from the database.
    var sorted = courses.slice().sort(function (a, b) {
      if (a.current !== b.current) return a.current ? -1 : 1;
      return (a.order || 0) - (b.order || 0);
    });

    picker.innerHTML = sorted.map(function (c, i) {
      var meta = [c.semester, c.level].filter(Boolean).join(' · ') ||
        c.category || '';
      return '<button role="tab" aria-selected="' + (i === 0 ? 'true' : 'false') + '" ' +
        'data-course="' + esc(c.slug) + '">' +
        '<span class="cname">' + esc(c.title) + '</span>' +
        '<span class="cmeta">' + esc(meta) + (c.current ? '' : ' · past') + '</span>' +
        '</button>';
    }).join('');

    panels.innerHTML = sorted.map(function (c, i) {
      return coursePanel(c, i !== 0);
    }).join('');

    var btns = Array.prototype.slice.call(picker.querySelectorAll('[data-course]'));
    var articles = Array.prototype.slice.call(panels.querySelectorAll('[data-panel]'));

    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        var key = b.getAttribute('data-course');
        btns.forEach(function (x) { x.setAttribute('aria-selected', x === b ? 'true' : 'false'); });
        articles.forEach(function (p) { p.hidden = p.getAttribute('data-panel') !== key; });
      });
    });
  }

  // --------------------------------------------------------- gallery

  function renderGallery(items) {
    var page = el('p-gallery');
    var tab = el('tab-gallery');
    var body = el('gallery-body');
    if (!page || !tab || !body) return;

    // No photographs means no tab at all, rather than a tab leading to an
    // empty page.
    if (!items || !items.length) {
      tab.hidden = true;
      page.hidden = true;
      return;
    }
    tab.hidden = false;

    // Group by album, preserving the order the API returned.
    var albums = [];
    var byName = {};
    items.forEach(function (it) {
      var name = it.album || '';
      if (!byName[name]) { byName[name] = []; albums.push(name); }
      byName[name].push(it);
    });

    body.innerHTML = albums.map(function (name) {
      var rows = byName[name];
      return (name
        ? '<div class="cohort-head" style="margin-top:2rem"><h2>' + esc(name) + '</h2>' +
          '<span class="count">' + rows.length +
          (rows.length === 1 ? ' photograph' : ' photographs') + '</span></div>'
        : '') +
        '<div class="gallery">' + rows.map(function (it, i) {
          var full = mediaUrl(it.photo);
          var thumb = full ? full + (full.indexOf('?') === -1 ? '?size=thumb' : '&size=thumb') : '';
          if (!full) return '';
          return '<figure class="shot">' +
            '<button type="button" class="shotbtn" data-full="' + full + '" ' +
              'data-caption="' + esc(it.caption || '') + '" ' +
              'aria-label="View larger: ' + esc(it.caption || 'photograph ' + (i + 1)) + '">' +
              '<img src="' + thumb + '" alt="' + esc(it.caption || '') + '" loading="lazy">' +
            '</button>' +
            (it.caption || it.taken
              ? '<figcaption>' + esc(it.caption || '') +
                (it.taken ? '<span class="when">' + esc(it.taken) + '</span>' : '') +
                '</figcaption>'
              : '') +
            '</figure>';
        }).join('') + '</div>';
    }).join('');
  }

  /* Lightbox. Built once and reused; Escape and a click outside close it. */
  var lightbox = null;
  function openLightbox(src, caption) {
    if (!lightbox) {
      lightbox = document.createElement('div');
      lightbox.className = 'lightbox';
      lightbox.hidden = true;
      lightbox.innerHTML =
        '<button type="button" class="lb-close" aria-label="Close">&times;</button>' +
        '<figure><img alt=""><figcaption></figcaption></figure>';
      document.body.appendChild(lightbox);

      lightbox.addEventListener('click', function (e) {
        if (e.target === lightbox || e.target.closest('.lb-close')) closeLightbox();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !lightbox.hidden) closeLightbox();
      });
    }
    var img = lightbox.querySelector('img');
    var cap = lightbox.querySelector('figcaption');
    img.setAttribute('src', src);
    img.setAttribute('alt', caption || '');
    cap.textContent = caption || '';
    cap.hidden = !caption;
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
    lightbox.querySelector('.lb-close').focus();
  }
  function closeLightbox() {
    if (lightbox) lightbox.hidden = true;
    document.body.style.overflow = '';
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.shotbtn') : null;
    if (btn) openLightbox(btn.getAttribute('data-full'), btn.getAttribute('data-caption'));
  });

  // ------------------------------------------------------------- load

  function paintAll(data) {
    var research = data.research || {};
    renderMetrics(data.metrics);
    renderPi(data.pi);
    renderThemes(research.theme || []);
    renderResearch(research);
    renderMembers(data.members || {});
    renderCourses(data.courses || []);
    renderGallery(data.gallery || []);
  }

  function clearDynamicChrome() {
    // Every strip, not just the first — same reason as renderMetrics.
    each('[data-metrics]', function (box) { box.innerHTML = ''; });
    each('[data-srcline]', function (line) { line.hidden = true; });
    var themes = el('themes');
    if (themes) themes.style.display = 'none';
  }

  function load(attempt) {
    fetch(apiUrl('/api/content'), { headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) {
          var e = new Error('HTTP ' + r.status);
          e.status = r.status;
          throw e;
        }
        return r.json();
      })
      .then(paintAll)
      .catch(function (err) {
        // A cold start shows up as a network failure or a 502/503/504 from the
        // host's proxy while the process boots. Those are worth retrying; a 404
        // or a 400 means the URL is wrong and retrying will not help.
        var transient = !err.status || err.status >= 502;

        if (transient && attempt <= RETRIES) {
          clearDynamicChrome();
          SECTION_NODES().forEach(function (s2) { waking(s2.node, attempt, RETRIES); });
          setTimeout(function () { load(attempt + 1); }, RETRY_DELAY);
          return;
        }

        console.error('[site] content load failed:', err);
        clearDynamicChrome();
        SECTION_NODES().forEach(function (s2) { fail(s2.node, s2.label); });
      });
  }

  load(1);
})();
