/* ═══════════════════════════════════════════════════════════════════
   سمسار طلبك — نظام الخرائط العملي (v3 — 2026-10-16)
   ─────────────────────────────────────────────────────────────────
   • خرائط العقارات + خريطة المكتب: OSM embed (iframe) — صفر مفاتيح
     https://www.openstreetmap.org/export/embed.html?bbox=…&layer=mapnik&marker=…
   • مُنتقي الموقع (agent.html): Leaflet 1.9.4 + بلاطات OSM القياسية فقط
     https://tile.openstreetmap.org/{z}/{x}/{y}.png مع إسناد إلزامي
   • Geocoding: Photon (lang=en) → Nominatim (accept-language=en) احتياطي
   • بدون أي API key • بدون تخزين دائم (ذاكرة الصفحة فقط)
   • Rate limit: طلب واحد/ثانية + AbortController + كاش ذاكرة للجلسة
   • لا pin كاذب: بدون GPS موثوق = إطار نطاق 500م أو بدون خريطة
   • كشف فشل حقيقي لا يعتمد على tileerror وحده:
     مؤقّت 8 ثوانٍ + فحص صحة المزوّد بلاطة + كشف البلاطة المزوّرة/الموسومة
     (HTTP 200 بصورة بديلة = فشل، لا نجاح)
   ─────────────────────────────────────────────────────────────────
   ملاحظة سياسة OSM: embed خدمة تطوعية (osm.org) وبلاطات tile.openstreetmap.org
   «not intended for commercial use» وقد تُحظر المواقع المخالفة لشروط الاستخدام
   (operations/osmfoundation.org + switch2osm.org/using-tiles). لذلك التدهور
   الرشيق عند الفشل إلزامي: nm-loaded + nm-failed + .nm-fail-msg + رابط Google Maps.
   ═══════════════════════════════════════════════════════════════════ */
(function (window, document) {
  'use strict';

  /* ═══ 1) الإعدادات ═══ */
  const NASR_CENTER = [30.0561, 31.3300];
  const NASR_ZOOM   = 13;
  // Greater Cairo — نطاق نتائج البحث (minLon, minLat, maxLon, maxLat)
  const SEARCH_BBOX = [31.15, 29.90, 31.60, 30.20];

  const LEAFLET = {
    css : ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css'],
    js  : ['https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',  'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js']
  };

  const TILES = [
    { // المزوّد الوحيد — بلاطات OpenStreetMap القياسية (بدون مفاتيح + إسناد إلزامي)
      // سياسة الاستخدام: openstreetmap.org/help/faq و switch2osm.org/using-tiles
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      opts: { maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' }
    }
  ];

  const GEO = {
    photonSearch : (q, lat, lng) => `https://photon.komoot.io/api?q=${encodeURIComponent(q)}&lang=en&limit=6&lat=${lat}&lon=${lng}&bbox=${SEARCH_BBOX.join(',')}`,
    photonReverse: (lat, lng)    => `https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&lang=en`,
    nomSearch    : (q)           => `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=1&accept-language=en&viewbox=${SEARCH_BBOX[0]},${SEARCH_BBOX[3]},${SEARCH_BBOX[2]},${SEARCH_BBOX[1]}&bounded=1&q=${encodeURIComponent(q)}`,
    nomReverse   : (lat, lng)    => `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&accept-language=en&zoom=18&lat=${lat}&lon=${lng}`,
    timeout: 7000,
    minGap : 1000 // Photon: طلب/ثانية
  };

  /* ═══ 2) الشوارع المعروفة (إحداثيات مؤكدة من OpenStreetMap — 2026-09-26)
     تُستخدم فقط لصفحات العقارات القديمة اللي معندهاش lat/lng.
     النتيجة دايمًا "دائرة تقريبية 500م" — مش pin.
     المفاتيح الأطول أولًا عشان "رابعة الاستثماري" تتطابق قبل "رابعة". ═══ */
  const KNOWN_STREETS = [
    { keys: ['رابعه الاستثماري', 'رابعة الاستثماري'],          en: 'Rabaa Al Adawiya Investment Buildings', c: [30.0710, 31.3377] },
    { keys: ['رابعه العدويه', 'رابعة العدوية', 'ميدان رابعه'],    en: 'Rabaa Al Adawiya Square',              c: [30.0669, 31.3258] },
    { keys: ['محمد حسن الجمل', 'حسن الجمل'],                    en: 'Mohamed Hassan Al Gamal Street',       c: [30.0672, 31.3407] },
    { keys: ['عبد الحميد بدوي', 'عبدالحميد بدوي'],              en: 'Abd Al Hamid Badawi Street',           c: [30.1056, 31.3769] },
    { keys: ['عبد الرزاق السنهوري', 'السنهوري'],                en: 'Abd Al Razak Al Sanhouri Street',      c: [30.0628, 31.3420] },
    { keys: ['حلمي حسن علي'],                                   en: 'Helmy Hassan Ali Street',              c: [30.0534, 31.3484] },
    { keys: ['مصطفي النحاس', 'مصطفى النحاس'],                   en: 'Moustafa Al Nahas Street',             c: [30.0550, 31.3480] },
    { keys: ['عباس العقاد'],                                    en: 'Abbas Al Aqad Street',                 c: [30.0611, 31.3375] },
    { keys: ['مكرم عبيد'],                                      en: 'Makram Ebeid Street',                  c: [30.0622, 31.3452] },
    { keys: ['حسن المأمون', 'حسن المامون'],                     en: 'Hassan Al Mamoun Street',              c: [30.0642, 31.3565] },
    { keys: ['احمد فخري', 'أحمد فخري'],                         en: 'Ahmed Fakhry Street',                  c: [30.0631, 31.3494] },
    { keys: ['يوسف عباس'],                                      en: 'Youssef Abbas Street',                 c: [30.0544, 31.3248] },
    { keys: ['شينزو آبي', 'شينزو ابي'],                         en: 'Shinzo Abe Axis',                      c: [30.0742, 31.4005] },
    { keys: ['السراج مول', 'سراج مول'],                         en: 'Al Serag Mall',                        c: [30.0508, 31.3496] },
    { keys: ['شارع الطيران', 'الطيران الرئيسي', 'من الطيران', 'تقاطع شارع الطيران'], en: 'Al Tayaran Street', c: [30.0605, 31.3270] }
  ];

  function normAr(s) {
    return String(s || '')
      .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/[ًٌٍَُِّْـ]/g, '')
      .replace(/[–—\-،,()\[\]«»"']/g, ' ')
      .replace(/\s+/g, ' ')
      .trim().toLowerCase();
  }

  function matchKnownStreet(text) {
    const t = normAr(text);
    if (!t) return null;
    // "امتداد X" أو كمبوند = مكان بعيد عن الشارع نفسه → مفيش دائرة (لا موقع كاذب)
    if (t.includes('امتداد') || t.includes('كمبوند')) return null;
    for (const s of KNOWN_STREETS) {
      for (const k of s.keys) {
        if (t.includes(normAr(k))) return s;
      }
    }
    return null;
  }

  /* ═══ 3) تحميل Leaflet كسول (مع CDN بديل) ═══ */
  let _leafletPromise = null;

  function loadCss(hrefs) {
    return new Promise((resolve) => {
      const tryIdx = (i) => {
        if (i >= hrefs.length) return resolve(false);
        if (document.querySelector(`link[href="${hrefs[i]}"]`)) return resolve(true);
        const l = document.createElement('link');
        l.rel = 'stylesheet'; l.href = hrefs[i]; l.crossOrigin = '';
        l.onload = () => resolve(true);
        l.onerror = () => { l.remove(); tryIdx(i + 1); };
        document.head.appendChild(l);
      };
      tryIdx(0);
    });
  }

  function loadScript(srcs) {
    return new Promise((resolve, reject) => {
      const tryIdx = (i) => {
        if (i >= srcs.length) return reject(new Error('leaflet-load-failed'));
        const s = document.createElement('script');
        s.src = srcs[i]; s.async = true; s.crossOrigin = '';
        s.onload = () => resolve(true);
        s.onerror = () => { s.remove(); tryIdx(i + 1); };
        document.head.appendChild(s);
      };
      tryIdx(0);
    });
  }

  function loadLeaflet() {
    if (window.L && window.L.map) return Promise.resolve(window.L);
    if (_leafletPromise) return _leafletPromise;
    _leafletPromise = Promise.all([loadCss(LEAFLET.css), loadScript(LEAFLET.js)])
      .then(() => { if (!window.L) throw new Error('leaflet-missing'); return window.L; })
      .catch((e) => { _leafletPromise = null; throw e; });
    return _leafletPromise;
  }

  /* ═══ 3-bis) OSM embed + فحص صحة البلاطات + كشف البلاطة المزوّرة ═══
     D1: خرائط العقارات والمكتب = iframe لـ osm.org/export/embed (صفر مفاتيح).
     D4: كشف الفشل لا يعتمد على onload وحده (onload يُطلق حتى لصفحة خطأ)،
     ولا على tileerror وحده (مزوّد قد يعيد HTTP 200 بصورة موسومة/بديلة):
       1) مؤقّت زمني 8 ثوانٍ لـ onload الإطار.
       2) فحص صحة المزوّد: تحميل بلاطة اختبارية من tile.openstreetmap.org.
       3) كشف البلاطة المزوّرة: تحليل بكسلات البلاطة على canvas (عند توفر CORS)
          وإلا بصمة/حجم البلاطة (256 أو 512) — بدون CORS لا يمكن قراءة محتوى
          نطاق آخر إطلاقًا، والبديل الموثّق هو فحص الأبعاد + فحص التحميل. */
  const OSM_EMBED_BASE = 'https://www.openstreetmap.org/export/embed.html';
  const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const EMBED_WATCHDOG_MS = 8000;  // onload لم يُطلق خلال 8 ثوانٍ = فشل
  const PROBE_TIMEOUT_MS = 6000;
  const PROBE_ZOOM = 13;

  function lngToTileX(lng, z) {
    return Math.floor(((lng + 180) / 360) * Math.pow(2, z));
  }
  function latToTileY(lat, z) {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z));
  }

  /** نطاق 500م (أو أي نصف قطر) حول نقطة: OSM bbox ترتيبها minLon,minLat,maxLon,maxLat. */
  function bboxAround(lat, lng, meters) {
    const dLat = meters / 111320;
    const dLng = meters / (111320 * Math.cos((lat * Math.PI) / 180));
    return {
      minLon: lng - dLng, minLat: lat - dLat,
      maxLon: lng + dLng, maxLat: lat + dLat
    };
  }

  /** رابط OSM embed: bbox=minLon%2CminLat%2CmaxLon%2CmaxLat و marker=lat%2Clng. */
  function osmEmbedUrl(lat, lng, meters) {
    const b = bboxAround(lat, lng, meters);
    const q = (n) => encodeURIComponent(String(Math.round(n * 1e6) / 1e6));
    return OSM_EMBED_BASE + '?bbox=' + [b.minLon, b.minLat, b.maxLon, b.maxLat].map(q).join('%2C') +
      '&layer=mapnik&marker=' + q(lat) + '%2C' + q(lng);
  }

  /** بلاطة اختبارية فوق مدينة نصر (عمرانية — لا تصلح لها صورة مسطّحة/موسومة). */
  function osmProbeTileUrl() {
    return OSM_TILES.replace('{z}', String(PROBE_ZOOM))
      .replace('{x}', String(lngToTileX(NASR_CENTER[1], PROBE_ZOOM)))
      .replace('{y}', String(latToTileY(NASR_CENTER[0], PROBE_ZOOM)));
  }

  function probeUrlFor(t) {
    if (typeof t.probe === 'string') return t.probe;
    return String(t.url)
      .replace('{s}', (t.opts && t.opts.subdomains) ? String(t.opts.subdomains)[0] : 'a')
      .replace('{z}', String(PROBE_ZOOM))
      .replace('{x}', String(lngToTileX(NASR_CENTER[1], PROBE_ZOOM)))
      .replace('{y}', String(latToTileY(NASR_CENTER[0], PROBE_ZOOM)))
      .replace('{r}', '');
  }

  /** بصمة الأبعاد (بدون CORS): بلاطة قياسية 256×256 (أو 512×512). */
  function classifyDimensions(img) {
    const w = img.naturalWidth | 0, h = img.naturalHeight | 0;
    if ((w === 256 || w === 512) && h === w) return { ok: true, method: 'size', reason: 'dimensions-ok' };
    return { ok: false, method: 'size', reason: 'unexpected-tile-size:' + w + 'x' + h };
  }

  /** كشف البلاطة «ذات اللون الواحد أو الموسومة» من بكسلات RGBA (نفس منطق علامة CARTO). */
  function classifyTilePixels(data, w, h) {
    const hist = new Map();
    let total = 0;
    for (let i = 0; i + 2 < data.length; i += 16) { // عيّنة كل 4 بكسلات
      const k = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      hist.set(k, (hist.get(k) || 0) + 1);
      total++;
    }
    if (!total) return { ok: false, method: 'canvas', reason: 'empty-tile' };
    let max = 0;
    hist.forEach((c) => { if (c > max) max = c; });
    const dominant = max / total;
    // خريطة حقيقية فوق مدينة = ألوان كثيرة؛ بلاطة موسومة/ملونة واحدة = لون مسيطر
    const forged = dominant >= 0.85 || (hist.size <= 8 && dominant >= 0.6);
    return {
      ok: !forged,
      method: 'canvas',
      reason: forged ? 'flat-or-watermarked-tile' : 'pixels-ok',
      dominantFraction: Math.round(dominant * 1000) / 1000,
      distinctColors: hist.size
    };
  }

  /**
   * classifyTile(img, opts) → { ok, method, reason }
   * يحاول تحليل البكسلات (canvas) — إن تعذّر (tainted/بلا CORS) يكتفي ببصمة الأبعاد.
   */
  function classifyTile(img, opts) {
    opts = opts || {};
    const dims = classifyDimensions(img);
    if (!dims.ok) return dims;
    try {
      const w = img.naturalWidth | 0, h = img.naturalHeight | 0;
      const canvas = opts.createCanvas ? opts.createCanvas(w, h) : document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) throw new Error('no-2d');
      ctx.drawImage(img, 0, 0);
      return classifyTilePixels(ctx.getImageData(0, 0, w, h).data, w, h);
    } catch (_) {
      return Object.assign({}, dims, { reason: 'cors-unavailable-dimensions-only' });
    }
  }

  /**
   * probeTileProvider(url, opts) → Promise<{ ok, method, reason }>
   * 1) صورة بدون CORS: نجاح التحميل + بصمة الأبعاد (onerror = المزوّد واقع).
   * 2) صورة مع CORS (اختيارية): تحليل البكسلات لكشف العلامة المائية/اللون الواحد.
   * opts.imgFactory / opts.createCanvas للحقن في الاختبارات الآلية.
   */
  function probeTileProvider(url, opts) {
    opts = opts || {};
    const makeImg = opts.imgFactory || (() => new Image());
    return new Promise((resolve) => {
      let done = false;
      const finish = (res) => { if (!done) { done = true; clearTimeout(timer); resolve(res); } };
      const timer = setTimeout(() => finish({ ok: false, method: 'timeout', reason: 'probe-timeout' }),
        opts.timeout || PROBE_TIMEOUT_MS);

      const plain = makeImg();
      plain.onload = () => {
        const dims = classifyDimensions(plain);
        if (!dims.ok) return finish(dims);
        const cors = makeImg();
        cors.crossOrigin = 'anonymous';
        cors.onload = () => finish(classifyTile(cors, opts));
        cors.onerror = () => finish(Object.assign({}, dims, { reason: 'cors-unavailable-dimensions-only' }));
        cors.src = url;
      };
      plain.onerror = () => finish({ ok: false, method: 'network', reason: 'probe-load-failed' });
      plain.src = url;
    });
  }

  function failMessageHtml(gmapsHref) {
    return '<div class="nm-fail-msg"><i class="fas fa-map"></i><span>تعذّر تحميل الخريطة حاليًا</span>' +
      '<a href="' + esc(gmapsHref || '#') + '" target="_blank" rel="noopener">افتح الموقع في Google Maps</a></div>';
  }

  /**
   * embedOsmMap(mapEl, opts) — يحقن iframe خرائط OSM داخل .nm-map-target.
   * opts: { lat, lng, meters, title, wrap, onFail, watchdogMs?, probeTimeoutMs?, imgFactory?, createCanvas? }
   * النجاح = onload للإطار + نجاح فحص البلاطة. الفشل = 8 ثوانٍ بدون onload، أو فشل/تزييف الفحص.
   * لا يُضاف sandbox (الإطار يحتاج سكربتاته) — loading lazy + referrerpolicy فقط.
   */
  function embedOsmMap(mapEl, opts) {
    const url = osmEmbedUrl(opts.lat, opts.lng, opts.meters);
    let settled = false, loaded = false, probeOk = false;
    const wrap = opts.wrap;
    const watchdog = setTimeout(() => { if (!loaded) fail(); }, opts.watchdogMs || EMBED_WATCHDOG_MS);
    const cleanup = () => { clearTimeout(watchdog); };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (wrap) wrap.classList.add('nm-loaded');
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (opts.onFail) opts.onFail();
    };
    const maybeSucceed = () => { if (loaded && probeOk) succeed(); };

    const ifr = document.createElement('iframe');
    ifr.src = url;
    ifr.loading = 'lazy';
    ifr.referrerPolicy = 'strict-origin-when-cross-origin';
    ifr.title = opts.title || 'خريطة';
    ifr.style.cssText = 'width:100%;height:100%;border:0;display:block';
    ifr.onload = () => { loaded = true; maybeSucceed(); };
    ifr.onerror = () => fail();
    if (mapEl) {
      mapEl.innerHTML = '';
      mapEl.appendChild(ifr);
    }

    probeTileProvider(osmProbeTileUrl(), {
      timeout: opts.probeTimeoutMs || PROBE_TIMEOUT_MS,
      imgFactory: opts.imgFactory,
      createCanvas: opts.createCanvas
    }).then((v) => {
      if (settled) return;
      if (mapEl && mapEl.dataset) mapEl.dataset.nmProbe = v.method || '';
      if (!v.ok) return fail();
      probeOk = true;
      maybeSucceed();
    });
  }

  /* ═══ 4) إنشاء خريطة موحّدة (tiles إنجليزية + fallback + RTL fix) ═══ */
  function goldIcon(L, size) {
    const w = size || 36, h = Math.round(w * 1.3);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 48" width="${w}" height="${h}" aria-hidden="true">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f5d76e"/><stop offset="1" stop-color="#b8860b"/></linearGradient></defs>
      <path d="M18 1C9.2 1 2 8.1 2 16.9 2 28.5 18 47 18 47s16-18.5 16-30.1C34 8.1 26.8 1 18 1z" fill="url(#g)" stroke="#5a4200" stroke-width="1.5"/>
      <circle cx="18" cy="17" r="6.5" fill="#fff" stroke="#5a4200" stroke-width="1.2"/>
    </svg>`;
    return L.divIcon({ className: 'nm-gold-pin', html: svg, iconSize: [w, h], iconAnchor: [w / 2, h - 2], popupAnchor: [0, -h + 6] });
  }

  /**
   * createMap(el, opts) → { map, ready: Promise<boolean> }
   * ready يتحل بـ true لما أول tile يتحمّل، false لو كل مزودي الـ tiles فشلوا.
   */
  function createMap(L, el, opts) {
    opts = opts || {};
    el.classList.add('nm-map');
    el.setAttribute('dir', 'ltr');

    const map = L.map(el, {
      center: opts.center || NASR_CENTER,
      zoom: opts.zoom || NASR_ZOOM,
      zoomControl: false,
      attributionControl: true,
      scrollWheelZoom: opts.scrollWheelZoom === true,
      dragging: opts.dragging !== false,
      tap: true,
      touchZoom: true,
      doubleClickZoom: true,
      minZoom: 10, maxZoom: 19
    });
    // أزرار الزوم على اليمين — مناسبة للاستخدام بإيد واحدة في واجهة RTL
    L.control.zoom({ position: 'topright' }).addTo(map);
    map.attributionControl.setPrefix('');

    let resolveReady;
    const ready = new Promise((r) => { resolveReady = r; });
    let settled = false;
    const settle = (ok) => { if (!settled) { settled = true; resolveReady(ok); } };

    function attachTiles(idx) {
      if (idx >= TILES.length) { el.classList.add('nm-map-failed'); settle(false); return; }
      const t = TILES[idx];
      const layer = L.tileLayer(t.url, t.opts);
      let loadedOne = false, errors = 0, probeOk = false, movingOn = false;
      const maybeSettle = () => {
        if (!settled && loadedOne && probeOk) { el.classList.add('nm-tiles-ready'); settle(true); }
      };
      const tryNext = () => {
        if (movingOn || settled) return;
        movingOn = true;
        layer.off();
        try { map.removeLayer(layer); } catch (_) {}
        attachTiles(idx + 1);
      };
      layer.on('tileload', () => { loadedOne = true; maybeSettle(); });
      layer.on('tileerror', () => {
        errors++;
        // لو 3 بلاطات فشلت قبل ما أي بلاطة تنجح → المزود ده واقع → بدّل
        if (!loadedOne && errors >= 3) tryNext();
      });
      layer.addTo(map);
      // D4: لا نعتمد على tileerror وحده — مزوّد قد يعيد HTTP 200 بصورة موسومة/بديلة.
      // فحص البلاطة (صحة المزوّد + كشف التزييف) شرط للنجاح أيضًا.
      probeTileProvider(probeUrlFor(t), { timeout: 8000 }).then((v) => {
        if (settled || movingOn) return;
        if (!v.ok) return tryNext();
        probeOk = true;
        maybeSettle();
      });
    }
    attachTiles(0);

    // مهلة أمان: لو مفيش أي tile اتحمّلت خلال 12 ثانية اعتبرها فاشلة
    setTimeout(() => settle(false), 12000);

    return { map, ready };
  }

  /* ═══ 5) Geocoding — Photon (en) → Nominatim (en) + rate limit + cache ═══ */
  const _cache = new Map();   // ذاكرة الجلسة فقط
  let _lastReqAt = 0;
  let _gate = Promise.resolve();

  function gated(fn) {
    // يضمن فاصل 1 ثانية بين الطلبات (Photon usage policy)
    const run = _gate.then(async () => {
      const wait = Math.max(0, _lastReqAt + GEO.minGap - Date.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      _lastReqAt = Date.now();
    });
    _gate = run.catch(() => {});
    return run.then(fn);
  }

  async function fetchJson(url, signal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GEO.timeout);
    const onAbort = () => ctrl.abort();
    if (signal) { if (signal.aborted) { clearTimeout(timer); throw new DOMException('aborted', 'AbortError'); } signal.addEventListener('abort', onAbort, { once: true }); }
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
      if (!r.ok) throw new Error('http-' + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  const uniq = (arr) => arr.filter((v, i) => v && arr.indexOf(v) === i);
  const num  = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const r5   = (n) => Math.round(n * 1e5) / 1e5;

  function fromPhoton(f) {
    const p = f.properties || {}, g = (f.geometry && f.geometry.coordinates) || [];
    const lng = num(g[0]), lat = num(g[1]);
    if (lat == null || lng == null) return null;
    const streetLine = [p.housenumber, p.street].filter(Boolean).join(' ');
    const line1 = p.name || streetLine || p.locality || p.district || p.city || 'Selected point';
    const line2 = uniq([p.name && streetLine ? streetLine : null, p.locality, p.district, p.city]).filter((x) => x !== line1).join(', ');
    return { lat: r5(lat), lng: r5(lng), line1, line2, label: uniq([line1, line2]).join(', '), kind: p.osm_value || p.type || '' };
  }

  function fromNominatim(o) {
    const lat = num(o.lat), lng = num(o.lon);
    if (lat == null || lng == null) return null;
    const a = o.address || {};
    const street = uniq([a.house_number, a.road || a.pedestrian || a.footway]).join(' ');
    const line1 = o.name || street || a.neighbourhood || a.suburb || a.city_district || 'Selected point';
    const line2 = uniq([o.name && street ? street : null, a.neighbourhood, a.suburb, a.city_district, a.city || a.town || a.state]).filter((x) => x !== line1).join(', ');
    return { lat: r5(lat), lng: r5(lng), line1, line2, label: uniq([line1, line2]).join(', '), kind: o.type || '' };
  }

  function dedupe(list) {
    const seen = new Set();
    return list.filter((x) => { if (!x) return false; const k = x.label + '|' + x.lat.toFixed(3) + '|' + x.lng.toFixed(3); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  async function searchPlaces(q, opts) {
    opts = opts || {};
    q = String(q || '').trim();
    if (q.length < 2) return [];
    const key = 's|' + q.toLowerCase();
    if (_cache.has(key)) return _cache.get(key);
    const [lat, lng] = opts.near || NASR_CENTER;
    let out = [];
    try {
      const j = await gated(() => fetchJson(GEO.photonSearch(q, lat, lng), opts.signal));
      out = dedupe((j.features || []).map(fromPhoton));
    } catch (e) { if (e && e.name === 'AbortError') throw e; }
    if (!out.length) {
      try {
        const j = await gated(() => fetchJson(GEO.nomSearch(q), opts.signal));
        out = dedupe((Array.isArray(j) ? j : []).map(fromNominatim));
      } catch (e) { if (e && e.name === 'AbortError') throw e; }
    }
    out = out.slice(0, 5);
    if (out.length) _cache.set(key, out);
    return out;
  }

  async function reverseGeocode(lat, lng, opts) {
    opts = opts || {};
    lat = r5(lat); lng = r5(lng);
    const key = 'r|' + lat.toFixed(4) + '|' + lng.toFixed(4);
    if (_cache.has(key)) return _cache.get(key);
    let res = null;
    try {
      const j = await gated(() => fetchJson(GEO.photonReverse(lat, lng), opts.signal));
      res = (j.features && j.features[0]) ? fromPhoton(j.features[0]) : null;
    } catch (e) { if (e && e.name === 'AbortError') throw e; }
    if (!res) {
      try {
        const j = await gated(() => fetchJson(GEO.nomReverse(lat, lng), opts.signal));
        res = j && !j.error ? fromNominatim(j) : null;
      } catch (e) { if (e && e.name === 'AbortError') throw e; }
    }
    // نرجّع النقطة اللي المستخدم اختارها فعلًا — مش نقطة أقرب عنوان
    if (res) { res = Object.assign({}, res, { lat, lng }); _cache.set(key, res); }
    return res;
  }

  /* ═══ 6) أدوات مشتركة ═══ */
  const gmapsPoint  = (lat, lng) => `https://maps.google.com/?q=${lat},${lng}`;
  const gmapsSearch = (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  const fmtCoords   = (lat, lng) => `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function whenVisible(el, cb) {
    if (!('IntersectionObserver' in window)) { cb(); return; }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); cb(); }
    }, { rootMargin: '300px 0px' });
    io.observe(el);
  }

  function invalidateSoon(map) {
    // Leaflet بيحتاج invalidateSize لو الحاوية اتغير حجمها بعد الإنشاء
    setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 60);
    setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 400);
  }

  /* ═══ 7) خريطة صفحة العقار ═══
     مستويات الدقة:
       exact    → lat/lng في front matter               → iframe OSM + marker دقيق
       building → lat/lng + map_precision: building     → نفس exact + تنويه "على مستوى العمارة"
       street   → لا GPS لكن الشارع معروف               → iframe OSM يوضّح نطاق 500م (بدون دائرة)
       area     → منطقة عامة                            → بدون خريطة + تنويه */
  function resolvePropertyLevel(ds) {
    const lat = num(ds.lat), lng = num(ds.lng);
    if (lat != null && lng != null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      return { level: (ds.precision || '').toLowerCase() === 'building' ? 'building' : 'exact', lat: r5(lat), lng: r5(lng) };
    }
    const s = matchKnownStreet(ds.location);
    if (s) return { level: 'street', lat: s.c[0], lng: s.c[1], streetEn: s.en };
    return { level: 'area' };
  }

  function renderProperty(section) {
    if (!section || section.dataset.nmDone) return;
    section.dataset.nmDone = '1';
    const ds = section.dataset;
    const wrap    = section.querySelector('.nm-map-wrap');
    const mapEl   = section.querySelector('.nm-map-target');
    const caption = section.querySelector('.nm-caption');
    const note    = section.querySelector('.nm-note');
    const link    = section.querySelector('.nm-gmaps');
    const res     = resolvePropertyLevel(ds);
    const locText = ds.location || '';

    if (caption) caption.textContent = locText;
    section.classList.add('nm-level-' + res.level);

    if (res.level === 'area') {
      if (wrap) wrap.remove();
      if (note) {
        note.innerHTML = '<i class="fas fa-info-circle"></i> الموقع الدقيق للعقار يُحدَّد عند التواصل مع طارق — الخريطة تُعرض فقط للعقارات ذات الموقع المؤكد.';
        note.classList.add('show');
      }
      if (link) { link.href = gmapsSearch(locText); }
      return;
    }

    if (link) link.href = res.level === 'street' ? gmapsSearch(res.streetEn + ', Nasr City, Cairo') : gmapsPoint(res.lat, res.lng);
    if (note) {
      if (res.level === 'street') {
        // الدائرة الذهبية لم تُرسم بعد الآن — الإطار (الـiframe) هو ما يوضّح النطاق
        note.innerHTML = `<i class="fas fa-expand-arrows-alt"></i> موقع تقريبي — الإطار يوضّح نطاق <strong>${esc(res.streetEn)}</strong> (حوالي 500 متر). العنوان الدقيق عند التواصل.`;
        note.classList.add('show');
      } else if (res.level === 'building') {
        note.innerHTML = '<i class="fas fa-building"></i> الدبوس على مستوى العمارة — الشقة/الوحدة تُحدَّد عند المعاينة.';
        note.classList.add('show');
      }
    }

    if (!mapEl || !wrap) return;

    const fail = () => {
      wrap.classList.add('nm-loaded', 'nm-failed');
      mapEl.innerHTML = failMessageHtml(link ? link.href : gmapsSearch(locText));
    };

    whenVisible(section, () => {
      embedOsmMap(mapEl, {
        lat: res.lat,
        lng: res.lng,
        meters: res.level === 'street' ? 500 : 250,
        title: res.level === 'street'
          ? `خريطة تقريبية لموقع العقار — نطاق ${res.streetEn}`
          : `خريطة موقع العقار — ${ds.title || 'مدينة نصر'}`,
        wrap: wrap,
        onFail: fail
      });
    });
  }

  /* ═══ 8) خريطة المكتب — نفس مسار الـiframe (نطاق ≈300م + marker) ═══ */
  function renderOffice(section) {
    if (!section || section.dataset.nmDone) return;
    section.dataset.nmDone = '1';
    const lat = num(section.dataset.lat), lng = num(section.dataset.lng);
    const wrap = section.querySelector('.nm-map-wrap');
    const mapEl = section.querySelector('.nm-map-target');
    if (lat == null || lng == null || !mapEl || !wrap) return;
    const fail = () => {
      wrap.classList.add('nm-loaded', 'nm-failed');
      mapEl.innerHTML = failMessageHtml(gmapsPoint(lat, lng));
    };
    whenVisible(section, () => {
      embedOsmMap(mapEl, {
        lat: lat,
        lng: lng,
        meters: 300,
        title: 'خريطة موقع مكتب سمسار طلبك — مدينة نصر',
        wrap: wrap,
        onFail: fail
      });
    });
  }

  /* ═══ 9) Location Picker — للوكيل الذكي (agent.html) ═══
     createPicker(container, { required, onConfirm({lat,lng,address,line1,line2}), onManual() })
     • مربع بحث (debounce 400ms + AbortController) → dropdown 5 نتايج
     • دوس على الخريطة / سحب الدبوس → reverse geocode (en)
     • زر "موقعي الحالي" (Geolocation — بس عند ضغط المستخدم)
     • كل الحالة في الذاكرة فقط */
  function createPicker(container, opts) {
    opts = opts || {};
    const st = { sel: null, marker: null, map: null, L: null, ctrl: null, timer: null, destroyed: false };

    container.classList.add('nm-picker');
    container.setAttribute('dir', 'rtl');
    container.innerHTML = `
      <div class="nm-pk-head">
        <div class="nm-pk-title">📍 فين العقار بالظبط؟</div>
        <div class="nm-pk-sub">${opts.required ? 'ابحث عن الشارع أو دوس على الخريطة — الموقع مطلوب لطلبات البيع.' : 'ابحث عن الشارع أو دوس على الخريطة لتحديد الموقع.'}</div>
      </div>
      <div class="nm-pk-search">
        <i class="fas fa-search nm-pk-search-ico"></i>
        <input type="search" class="nm-pk-input" placeholder="ابحث عن شارع أو منطقة..." autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="ابحث عن شارع أو منطقة">
        <button type="button" class="nm-pk-clear" aria-label="مسح" hidden><i class="fas fa-times"></i></button>
        <div class="nm-pk-spinner" hidden></div>
        <ul class="nm-pk-results" role="listbox" hidden></ul>
      </div>
      <div class="nm-map-wrap nm-pk-mapwrap">
        <div class="nm-skeleton" aria-hidden="true"><div class="nm-skeleton-shimmer"></div><span>جاري تحميل الخريطة…</span></div>
        <div class="nm-map-target" role="application" aria-label="خريطة تفاعلية لتحديد موقع العقار"></div>
        <button type="button" class="nm-pk-locate" title="موقعي الحالي" aria-label="موقعي الحالي"><i class="fas fa-location-crosshairs"></i></button>
        <div class="nm-pk-hint">👆 دوس على مكان العقار</div>
      </div>
      <div class="nm-pk-result" aria-live="polite">
        <div class="nm-pk-result-label">📌 الموقع المختار:</div>
        <div class="nm-pk-result-box nm-empty">
          <div class="nm-pk-r1">لم يتم تحديد موقع بعد</div>
          <div class="nm-pk-r2"></div>
          <div class="nm-pk-r3" dir="ltr"></div>
        </div>
      </div>
      <div class="nm-pk-actions">
        <button type="button" class="nm-pk-btn nm-pk-confirm" disabled>✅ تمام، ده المكان</button>
        <button type="button" class="nm-pk-btn nm-pk-manual">✏️ اكتب يدويًا</button>
      </div>`;

    const $ = (s) => container.querySelector(s);
    const input = $('.nm-pk-input'), clearBtn = $('.nm-pk-clear'), spinner = $('.nm-pk-spinner'), list = $('.nm-pk-results');
    const wrap = $('.nm-pk-mapwrap'), mapEl = $('.nm-map-target'), hint = $('.nm-pk-hint'), locateBtn = $('.nm-pk-locate');
    const box = $('.nm-pk-result-box'), r1 = $('.nm-pk-r1'), r2 = $('.nm-pk-r2'), r3 = $('.nm-pk-r3');
    const confirmBtn = $('.nm-pk-confirm'), manualBtn = $('.nm-pk-manual');

    function setBusy(on) { spinner.hidden = !on; }
    function showResult(sel, pending) {
      st.sel = sel;
      box.classList.toggle('nm-empty', !sel);
      box.classList.toggle('nm-pending', !!pending);
      if (!sel) { r1.textContent = 'لم يتم تحديد موقع بعد'; r2.textContent = ''; r3.textContent = ''; confirmBtn.disabled = true; return; }
      r1.textContent = sel.line1 || sel.label || 'Selected point';
      r2.textContent = sel.line2 || '';
      r3.textContent = fmtCoords(sel.lat, sel.lng);
      confirmBtn.disabled = !!pending;
    }

    function placeMarker(lat, lng) {
      const L = st.L, map = st.map;
      if (!L || !map) return;
      if (!st.marker) {
        st.marker = L.marker([lat, lng], { icon: goldIcon(L, 40), draggable: true, autoPan: true }).addTo(map);
        st.marker.on('dragend', () => { const p = st.marker.getLatLng(); pickPoint(p.lat, p.lng, true); });
      } else st.marker.setLatLng([lat, lng]);
      hint.classList.add('hide');
    }

    async function pickPoint(lat, lng, keepView) {
      lat = r5(lat); lng = r5(lng);
      placeMarker(lat, lng);
      if (!keepView) st.map.panTo([lat, lng]);
      // عرض الإحداثيات فورًا + العنوان لما يوصل
      showResult({ lat, lng, line1: 'جاري تحديد العنوان…', line2: '', label: '' }, true);
      if (st.ctrl) st.ctrl.abort();
      st.ctrl = new AbortController();
      setBusy(true);
      try {
        const res = await reverseGeocode(lat, lng, { signal: st.ctrl.signal });
        if (st.destroyed) return;
        if (res) showResult(res, false);
        else showResult({ lat, lng, line1: 'Selected point (no address found)', line2: 'Nasr City, Cairo', label: 'Selected point' }, false);
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        showResult({ lat, lng, line1: 'Selected point', line2: 'Nasr City, Cairo', label: 'Selected point' }, false);
      } finally { setBusy(false); }
    }

    function selectResult(item) {
      list.hidden = true; list.innerHTML = '';
      input.value = item.label || item.line1;
      clearBtn.hidden = !input.value;
      const z = /street|road|residential|primary|secondary|tertiary/i.test(item.kind) ? 16 : 17;
      if (st.map) { st.map.flyTo([item.lat, item.lng], z, { duration: 0.6 }); placeMarker(item.lat, item.lng); }
      showResult(item, false);
    }

    function renderList(items) {
      list.innerHTML = '';
      if (!items.length) {
        list.innerHTML = '<li class="nm-pk-noresult">مفيش نتايج — جرّب اسم الشارع بالإنجليزي أو دوس على الخريطة مباشرة</li>';
        list.hidden = false; return;
      }
      items.forEach((it, i) => {
        const li = document.createElement('li');
        li.className = 'nm-pk-item'; li.setAttribute('role', 'option'); li.tabIndex = 0; li.dataset.idx = i;
        li.innerHTML = `<span class="nm-pk-item-ico"><i class="fas fa-map-marker-alt"></i></span><span class="nm-pk-item-txt" dir="ltr"><strong>${esc(it.line1)}</strong>${it.line2 ? `<small>${esc(it.line2)}</small>` : ''}</span>`;
        li.addEventListener('click', () => selectResult(it));
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectResult(it); });
        list.appendChild(li);
      });
      list.hidden = false;
    }

    async function doSearch(q) {
      if (st.ctrl) st.ctrl.abort();
      st.ctrl = new AbortController();
      setBusy(true);
      try {
        const items = await searchPlaces(q, { signal: st.ctrl.signal });
        if (st.destroyed || input.value.trim() !== q) return;
        renderList(items);
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        renderList([]);
      } finally { setBusy(false); }
    }

    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearBtn.hidden = !q;
      clearTimeout(st.timer);
      if (q.length < 2) { list.hidden = true; list.innerHTML = ''; return; }
      st.timer = setTimeout(() => doSearch(q), 400); // debounce 400ms
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(st.timer); const q = input.value.trim(); if (q.length >= 2) doSearch(q); }
      if (e.key === 'Escape') { list.hidden = true; }
      if (e.key === 'ArrowDown') { const f = list.querySelector('.nm-pk-item'); if (f) { e.preventDefault(); f.focus(); } }
    });
    clearBtn.addEventListener('click', () => { input.value = ''; clearBtn.hidden = true; list.hidden = true; list.innerHTML = ''; input.focus(); });
    document.addEventListener('click', (e) => { if (!container.contains(e.target)) list.hidden = true; });

    locateBtn.addEventListener('click', () => {
      if (!navigator.geolocation || !st.map) return;
      locateBtn.classList.add('busy');
      navigator.geolocation.getCurrentPosition(
        (pos) => { locateBtn.classList.remove('busy'); st.map.setView([pos.coords.latitude, pos.coords.longitude], 17); pickPoint(pos.coords.latitude, pos.coords.longitude, true); },
        () => { locateBtn.classList.remove('busy'); if (opts.onToast) opts.onToast('تعذّر تحديد موقعك — ابحث أو دوس على الخريطة'); },
        { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
      );
    });

    confirmBtn.addEventListener('click', () => {
      if (!st.sel || confirmBtn.disabled) return;
      const s = st.sel;
      const address = uniq([s.line1, s.line2]).join(', ');
      if (opts.onConfirm) opts.onConfirm({ lat: s.lat, lng: s.lng, address, line1: s.line1, line2: s.line2 || '' });
    });
    manualBtn.addEventListener('click', () => { if (opts.onManual) opts.onManual(); });

    // الخريطة
    (async () => {
      let L;
      try { L = await loadLeaflet(); } catch (_) { return fail(); }
      if (st.destroyed) return;
      st.L = L;
      const { map, ready } = createMap(L, mapEl, { center: NASR_CENTER, zoom: NASR_ZOOM, scrollWheelZoom: true });
      st.map = map;
      map.on('click', (e) => pickPoint(e.latlng.lat, e.latlng.lng, false));
      invalidateSoon(map);
      const ok = await ready;
      if (st.destroyed) return;
      if (!ok) return fail();
      wrap.classList.add('nm-loaded');
      setTimeout(() => { try { input.focus({ preventScroll: true }); } catch (_) {} }, 150);
    })();

    function fail() {
      wrap.classList.add('nm-loaded', 'nm-failed');
      mapEl.innerHTML = '<div class="nm-fail-msg"><i class="fas fa-map"></i><span>الخريطة مش متاحة دلوقتي — اكتب العنوان يدويًا</span></div>';
      hint.classList.add('hide');
    }

    return {
      get selection() { return st.sel; },
      setView(lat, lng, z) { if (st.map) st.map.setView([lat, lng], z || 16); },
      destroy() {
        st.destroyed = true;
        clearTimeout(st.timer);
        if (st.ctrl) st.ctrl.abort();
        try { if (st.map) st.map.remove(); } catch (_) {}
        container.innerHTML = '';
        container.classList.remove('nm-picker');
      }
    };
  }

  /* ═══ 10) Auto-init ═══ */
  function autoInit() {
    document.querySelectorAll('[data-nm="property"]').forEach(renderProperty);
    document.querySelectorAll('[data-nm="office"]').forEach(renderOffice);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoInit);
  else autoInit();

  window.NasrMaps = {
    NASR_CENTER, NASR_ZOOM,
    loadLeaflet, createMap, goldIcon,
    searchPlaces, reverseGeocode, matchKnownStreet,
    renderProperty, renderOffice, createPicker,
    gmapsPoint, gmapsSearch,
    embedOsmMap, osmEmbedUrl, bboxAround, failMessageHtml,
    _internals: {
      resolvePropertyLevel, fromPhoton, fromNominatim, normAr, KNOWN_STREETS,
      classifyTilePixels, classifyTile, classifyDimensions, probeTileProvider,
      lngToTileX, latToTileY, osmProbeTileUrl, probeUrlFor,
      EMBED_WATCHDOG_MS, PROBE_TIMEOUT_MS, OSM_EMBED_BASE, OSM_TILES, TILES, SEARCH_BBOX
    }
  };
})(window, document);
