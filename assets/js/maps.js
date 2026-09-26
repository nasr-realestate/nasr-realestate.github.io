/* ═══════════════════════════════════════════════════════════════════
   سمسار طلبك — نظام الخرائط التفاعلية المجانية (2026-09-26)
   ─────────────────────────────────────────────────────────────────
   Leaflet 1.9.4 (unpkg) + بلاطات OpenStreetMap عبر OpenFreeMap
   (ستايل liberty كـ vector عبر ربط maplibre-gl-leaflet الرسمي،
   مع fallback تلقائي لصور tile.openstreetmap.org الراسترية)
   + Photon (Komoot) للـ geocoding مع Nominatim كاحتياط.

   القواعد الصارمة المطبَّقة هنا:
   • بدون أي API key وبدون أي خدمة مدفوعة (لا Google Maps API إطلاقًا).
   • لا تخزين دائم لأي إحداثيات — كاش في الذاكرة العابرة للصفحة فقط.
   • لا pin كاذب: عقار بدون GPS موثوق يظهر كدائرة تقريبية (500م)
     أو بدون خريطة خالص (مستوى الدقة 4).
   • الإسناد إجباري في كل خريطة: © OpenStreetMap contributors.
   • Photon: حد أقصى طلب واحد/ثانية + إلغاء الطلب السابق عند طلب جديد
     + كاش في الذاكرة للجلسة فقط (الـ debounce 500ms في منتقي
     الوكيل — agent.html — لأنه الخاص بالضغطات).
   • ملاحظة تقنية: Photon لا يقبل lang=ar (يرفض الطلب بخطأ
     "Language is not supported") — نستخدم الوضع الافتراضي
     (يعيد الأسماء المحلية) و Nominatim (accept-language=ar) احتياطًا.
   ═══════════════════════════════════════════════════════════════════ */
(function (window, document) {
  'use strict';

  /* ═══ 1) ثوابت ═══ */

  const WA_PHONE  = '201147758857';                      // واتساب طارق
  const NASR_CENTER = [30.0600, 31.3400];                // مركز مدينة نصر
  // حدود مدينة نصر الكبرى — أي نتيجة geocoding خارجها تُرفض (منع دوائر/دبابيس كاذبة)
  const NASR_BBOX  = { minLat: 30.00, maxLat: 30.13, minLng: 31.23, maxLng: 31.48 };

  const LEAFLET_JS   = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  const LEAFLET_CSS  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  const LEAFLET_JS2  = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';   // CDN بديل (طوارئ)
  const LEAFLET_CSS2 = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';

  const MAPLIBRE_JS   = 'https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js';
  const MAPLIBRE_CSS  = 'https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css';
  const MAPLIBRE_GL_LEAFLET = 'https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.4/dist/leaflet-maplibre-gl.js';

  const OFM_STYLE  = 'https://tiles.openfreemap.org/styles/liberty';  // OpenFreeMap (OSM data)
  const OSM_RASTER = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const OSM_ATTR   = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>';

  const PHOTON_REV  = (lat, lng) => `https://photon.komoot.io/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
  const PHOTON_FWD  = (q, lat, lng) => `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1` +
    (Number.isFinite(lat) && Number.isFinite(lng) ? `&lat=${lat}&lon=${lng}` : '');
  const NOMINATIM_REV = (lat, lng) => `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&accept-language=ar&zoom=17`;
  const NOMINATIM_FWD = (q) => `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ar&viewbox=${NASR_BBOX.minLng},${NASR_BBOX.maxLat},${NASR_BBOX.maxLng},${NASR_BBOX.minLat}&bounded=1&q=${encodeURIComponent(q)}`;

  const GEO_TIMEOUT  = 7000;   // مهلة كل استدعاء geocoding
  const GEO_MIN_GAP  = 1000;   // حد Photon: طلب واحد في الثانية لكل مستخدم

  /* ═══ 2) تطبيع النص العربي (نفس منطق normAr في _worker/worker.js) ═══ */

  function normAr(s) {
    return String(s || '')
      .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
      .replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي')
      .replace(/[ًٌٍَُِّْـ]/g, '')
      .replace(/[^\w\u0600-\u06FF]/g, '')
      .toLowerCase();
  }

  /* ═══ 3) MASTER_LANDMARKS — مرجع الشوارع من _worker/worker.js ═══
     قسم "الشوارع المعروفة" فقط هو اللي بيأهل للمستوى 3.
     المناطق العامة (المنطقة الأولى، الحي السابع، المربع الذهبي…)
     متعمدة بدون إحداثيات → مستوى 4 بدون خريطة خالص. */

  const KNOWN_STREETS = [
    'عباس العقاد', 'مكرم عبيد', 'مصطفى النحاس', 'شارع الطيران',
    'حسن المأمون', 'حسنين هيكل', 'يوسف عباس', 'أحمد فؤاد نسيم',
    'عبد الحميد بدوي', 'الطوخي', 'رابعة العدوية', 'شينزو آبي',
    'أحمد فخري', 'عبد الله العربي', 'معز الدولة', 'المقريفي',
    'حلمي حسن علي', 'إبراهيم نواره', 'التعاونيات', 'سراج مول',
  ];

  /* إحداثيات مؤكدة من OpenStreetMap (Nominatim/Photon — 2026-09-26).
     الشوارع غير المذكورة هنا بتُحاول ديناميكيًا في المتصفح أولًا،
     ولو فشل التحقق → مستوى 4 (بدون خريطة) — مفيش pin كاذب أبدًا. */
  const STREET_COORDS = {
    'عباس العقاد':   [30.0611, 31.3375],
    'مكرم عبيد':     [30.0618, 31.3451],
    'مصطفى النحاس':  [30.0551, 31.3518],
    'شارع الطيران':  [30.0579, 31.3261],
    'حسنين هيكل':    [30.0611, 31.3384],
    'يوسف عباس':     [30.0605, 31.3234],
    'رابعة العدوية': [30.0690, 31.3220],
    'شينزو آبي':     [30.0745, 31.4113],
    'أحمد فخري':     [30.0652, 31.3493],
    'عبد الله العربي':[30.0463, 31.3286],
    'حلمي حسن علي':  [30.0538, 31.3528],
    'سراج مول':      [30.0508, 31.3495],
    'إبراهيم نواره': [30.0685, 31.3500],
  };

  /* مطابقة اسم شارع مع تجاهل كلمة "شارع" البادئة (الطيران = شارع الطيران) */
  const streetKey = (name) => normAr(name).replace(/^شارع/, '');

  const staticCoordFor = (name) => {
    if (!name) return null;
    const n = streetKey(name);
    for (const key of Object.keys(STREET_COORDS)) {
      if (streetKey(key) === n) return STREET_COORDS[key];
    }
    return null;
  };

  /* البحث عن أطول شارع معروف داخل نص الموقع (مع تفضيل اللي له إحداثيات ثابتة) */
  function findKnownStreet(text) {
    const t = normAr(text);
    if (!t) return null;
    const egyptAir = normAr('مصر للطيران'); // "الطيران" جوه "مصر للطيران" = مطاررة مش شارع
    let best = null, bestHasCoords = false, bestLen = 0;
    for (const name of KNOWN_STREETS) {
      const n = streetKey(name);
      if (!n || !t.includes(n)) continue;
      if (n === 'الطيران' && t.includes(egyptAir)) continue;
      const hasCoords = !!staticCoordFor(name);
      if (
        !best ||
        (hasCoords && !bestHasCoords) ||
        (hasCoords === bestHasCoords && n.length > bestLen)
      ) {
        best = name; bestHasCoords = hasCoords; bestLen = n.length;
      }
    }
    return best;
  }

  /* استخراج اسم الشارع من نص حر (للمستوى 2 لما الشارع مش معروف) */
  function extractStreetPhrase(text) {
    const m = String(text || '').match(/شارع\s+[\u0600-\u06FF\s]{3,28}/);
    return m ? m[0].replace(/\s*[،,\-–—(].*$/, '').trim() : '';
  }

  /* ═══ 4) تحميل Leaflet (مع CDN بديل) ═══ */

  const _loaded = {};
  function loadScript(src) {
    if (_loaded[src]) return _loaded[src];
    _loaded[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { delete _loaded[src]; reject(new Error('script ' + src)); };
      document.head.appendChild(s);
    });
    return _loaded[src];
  }
  function loadCss(href) {
    if (document.querySelector(`link[data-maps-css="${href}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href; l.dataset.mapsCss = href;
    document.head.appendChild(l);
  }

  function webglSupported() {
    try {
      const c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch (_) { return false; }
  }

  let _leafletPromise = null;
  function ensureLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (_leafletPromise) return _leafletPromise;
    _leafletPromise = (async () => {
      // Leaflet محمّل من <head> بـ defer — نستنى شوية لو لسه
      for (let i = 0; i < 40 && !window.L; i++) await new Promise(r => setTimeout(r, 50));
      if (window.L) return window.L;
      // CDN الأساسي فشل → jsdelivr (تعليمات الطوارئ)
      try {
        loadCss(LEAFLET_CSS2);
        await loadScript(LEAFLET_JS2);
        if (window.L) return window.L;
      } catch (_) { /* جربنا */ }
      // محاولة أخيرة بحقن unpkg يدويًا (لو كان head جاهل script من الأساس)
      try {
        loadCss(LEAFLET_CSS);
        await loadScript(LEAFLET_JS);
        if (window.L) return window.L;
      } catch (_) { /* خلصنا */ }
      throw new Error('leaflet-unavailable');
    })();
    return _leafletPromise;
  }

  /* ═══ 5) إنشاء الخريطة + طبقة الأساس ═══
     الأولوية: OpenFreeMap (vector عبر maplibre-gl-leaflet — الطريقة
     الموثقة رسميًا لاستخدام OpenFreeMap مع Leaflet) ثم صور OSM
     الراسترية كـ fallback (بدون مفاتيح، وبدون تكلفة). */

  async function createMap(el, opts = {}) {
    const L = await ensureLeaflet();
    const map = L.map(el, {
      scrollWheelZoom: !!opts.scrollZoom,
      attributionControl: true,
    }).setView(opts.center || NASR_CENTER, opts.zoom || 13);

    let usingVector = false;
    if (webglSupported()) {
      try {
        loadCss(MAPLIBRE_CSS);
        await loadScript(MAPLIBRE_JS);
        await loadScript(MAPLIBRE_GL_LEAFLET);
        if (typeof L.maplibreGL !== 'function') throw new Error('maplibre-gl-leaflet missing');
        const gl = L.maplibreGL({ style: OFM_STYLE }).addTo(map);
        usingVector = true;
        // لو الستايل نفسه فشل في التحميل (شبكة مثلًا) → بدّل للراستر بدل خريطة سودة
        try {
          const glm = (typeof gl.getMaplibreMap === 'function' && gl.getMaplibreMap()) || gl._glMap;
          if (glm && typeof glm.on === 'function') {
            let styleReady = false;
            glm.on('load', () => { styleReady = true; });
            glm.on('error', (e) => {
              if (styleReady) return; // أخطاء البلاطات الفردية مش قاتلة
              const msg = String((e && e.error && (e.error.message || e.error.status)) || e?.error || '');
              if (/style|fetch|network|Failed|error loading|404|502|503/i.test(msg)) {
                try { map.removeLayer(gl); } catch (_) {}
                addRasterBasemap(L, map);
              }
            });
          }
        } catch (_) { /* مش مهم */ }
      } catch (_) { usingVector = false; }
    }
    if (!usingVector) addRasterBasemap(L, map);

    setTimeout(() => { try { map.invalidateSize(); } catch (_) {} }, 120);
    return { L, map };
  }

  function addRasterBasemap(L, map) {
    L.tileLayer(OSM_RASTER, {
      maxZoom: 19,
      attribution: OSM_ATTR, // © OpenStreetMap contributors
    }).addTo(map);
  }

  /* الدبوس الذهبي (SVG/CSS خالص — بدون أي صور مولّدة) */
  function goldPin(L, opts = {}) {
    const inner = opts.office
      ? '<i class="fas fa-building" aria-hidden="true"></i>'
      : '<span class="semsar-pin-dot" aria-hidden="true"></span>';
    return L.divIcon({
      className: 'semsar-pin' + (opts.cls ? ' ' + opts.cls : ''),
      html: `<div class="semsar-pin-body">${inner}</div>`,
      iconSize: [30, 42],
      iconAnchor: [15, 40],
      popupAnchor: [0, -36],
    });
  }

  /* ═══ 6) Geocoding — ديناميكي في المتصفح فقط ═══
     • Photon أولًا (مجاني، بدون مفتاح، مستدام) — بدون lang=ar (غير مدعومة).
     • Nominatim احتياط (accept-language=ar).
     • حد طلب/ثانية + إلغاء الطلب السابق + كاش في الذاكرة للجلسة فقط.
     • مفيش أي تخزين في localStorage/sessionStorage إطلاقًا. */

  const geoMemCache = new Map();              // كاش الذاكرة العابرة — للجلسة فقط
  let geoLastCallAt = 0;
  let geoAbort = null;

  async function geoThrottle() {
    const wait = GEO_MIN_GAP - (Date.now() - geoLastCallAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    geoLastCallAt = Date.now();
  }

  async function fetchJson(url) {
    if (geoAbort) { try { geoAbort.abort(); } catch (_) {} }  // إلغاء الطلب القديم
    geoAbort = new AbortController();
    const timer = setTimeout(() => { try { geoAbort.abort(); } catch (_) {} }, GEO_TIMEOUT);
    try {
      const res = await fetch(url, { signal: geoAbort.signal, headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
      if (geoAbort && geoAbort.signal.aborted) geoAbort = null;
    }
  }

  const inNasrBbox = (lat, lng) =>
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= NASR_BBOX.minLat && lat <= NASR_BBOX.maxLat &&
    lng >= NASR_BBOX.minLng && lng <= NASR_BBOX.maxLng;

  /* تحويل إحداثيات → عنوان (يستخدمه منتقي الوكيل عند الضغط على الخريطة) */
  async function reverseGeocode(lat, lng) {
    const key = 'rev:' + Number(lat).toFixed(5) + ',' + Number(lng).toFixed(5);
    if (geoMemCache.has(key)) return geoMemCache.get(key);
    await geoThrottle();
    // 1) Photon
    try {
      const d = await fetchJson(PHOTON_REV(lat, lng));
      const f = d && d.features && d.features[0];
      if (f && f.geometry && Array.isArray(f.geometry.coordinates)) {
        const p = f.properties || {};
        const label = [p.name, p.street, p.district, p.locality, p.city]
          .filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('، ');
        if (label) { geoMemCache.set(key, label); return label; }
      }
    } catch (_) { /* نكمل للاحتياط */ }
    // 2) Nominatim (احتياط)
    try {
      const d = await fetchJson(NOMINATIM_REV(lat, lng));
      if (d && d.display_name) {
        const label = String(d.display_name).split(',').slice(0, 4).map(s => s.trim()).join('، ');
        geoMemCache.set(key, label); return label;
      }
    } catch (_) { /* فشل الاتنين */ }
    return '';
  }

  /* تحويل عنوان/شارع → إحداثيات (للمستويين 2 و3 لما مفيش إحداثيات ثابتة).
     نتيجة غير مؤكدة (اسم مختلف أو خارج مدينة نصر) = مرفوضة — مفيش pin كاذب. */
  async function forwardGeocodeVerified(query, expectedName) {
    const key = 'fwd:' + normAr(query);
    if (geoMemCache.has(key)) return geoMemCache.get(key);
    const expect = normAr(expectedName || query);
    await geoThrottle();
    // 1) Photon (مع bias نحو مدينة نصر)
    try {
      const d = await fetchJson(PHOTON_FWD(query, NASR_CENTER[0], NASR_CENTER[1]));
      const f = d && d.features && d.features[0];
      if (f && f.geometry && Array.isArray(f.geometry.coordinates)) {
        const [lng, lat] = f.geometry.coordinates.map(Number);
        const p = f.properties || {};
        const hay = normAr([p.name, p.street, p.district, p.locality].filter(Boolean).join(' '));
        if (inNasrBbox(lat, lng) && hay && (hay.includes(expect) || expect.includes(hay))) {
          const hit = { lat, lng };
          geoMemCache.set(key, hit); return hit;
        }
      }
    } catch (_) { /* نكمل للاحتياط */ }
    // 2) Nominatim (مقيد بحدود مدينة نصر)
    try {
      const d = await fetchJson(NOMINATIM_FWD(query));
      if (Array.isArray(d) && d[0]) {
        const lat = Number(d[0].lat), lng = Number(d[0].lon);
        const hay = normAr(d[0].display_name || '');
        if (inNasrBbox(lat, lng) && hay && (hay.includes(expect) || expect.includes(hay))) {
          const hit = { lat, lng };
          geoMemCache.set(key, hit); return hit;
        }
      }
    } catch (_) { /* فشل الاتنين → مستوى 4 */ }
    geoMemCache.set(key, null);
    return null;
  }

  /* ═══ 7) كشف مستوى دقة الموقع (detectLocationAccuracy) ═══
     1 = GPS في front matter → pin ذهبي دقيق بدون تنويه
     2 = رقم عمارة بدون (منطقة/حي/مدينة نصر) → pin ذهبي + تنويه صغير
     3 = شارع معروف (MASTER_LANDMARKS) → دائرة شفافة 500م + تنويه برتقالي
     4 = منطقة عامة فقط → بدون خريطة خالص + تنويه واضح + CTA كبير */

  function validGps(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) &&
      lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 &&
      !(lat === 0 && lng === 0);
  }

  function detectLocationAccuracy(cfg) {
    const lat = Number(cfg && cfg.gpsLat);
    const lng = Number(cfg && cfg.gpsLng);
    if (validGps(lat, lng)) return { level: 1, lat, lng };

    const loc = String((cfg && cfg.location) || '').trim();
    if (!loc) return { level: 4, location: '' };

    const hasDigit = /[0-9٠-٩]/.test(loc);                       // رقم عمارة؟
    const hasAreaWord = /(منطقة|حي|مدينة نصر)/.test(loc);        // كلمة منطقة عامة؟
    // ما بين الأقواس = مرجع مساعد مش شارع العقار نفسه:
    // "المنطقة العاشرة (أول محور شينزو آبي)" → مستوى 4، بينما
    // "محور شينزو آبي الرئيسي - مدينة نصر" (بدون أقواس) → مستوى 3.
    const street = findKnownStreet(loc.replace(/\([^)]*\)/g, ' '));

    if (hasDigit && !hasAreaWord) return { level: 2, street, location: loc };
    if (street) return { level: 3, street, location: loc };
    return { level: 4, location: loc };
  }

  /* ═══ 8) زر CTA الموحّد — askExactLocation ═══ */

  function buildExactLocationWaUrl(title) {
    const msg =
      'السلام عليكم أ. طارق،\n' +
      'شفت العقار ده على الموقع:\n' +
      '*' + (title || 'عقار') + '*\n' +
      window.location.href + '\n\n' +
      'محتاج أعرف الموقع بالظبط على الخريطة 🙏';
    return 'https://wa.me/' + WA_PHONE + '?text=' + encodeURIComponent(msg);
  }

  /* ═══ 9) تحميل كسول (loading="lazy" للخرائط) ═══ */

  function lazyWhenVisible(target, fn) {
    if (!('IntersectionObserver' in window)) { fn(); return; }
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) { io.disconnect(); fn(); return; }
      }
    }, { rootMargin: '250px' });
    io.observe(target);
  }

  /* ═══ 10) صفحة العقار — initPropertyMap ═══ */

  function renderLevel4(section, verdict) {
    const statusEl = section.querySelector('.location-status');
    const textEl = section.querySelector('.location-text');
    const ctaEl = section.querySelector('.map-cta');
    const mapEl = section.querySelector('.location-map');
    section.classList.add('location-unknown');
    if (mapEl) mapEl.hidden = true;
    if (statusEl) {
      statusEl.className = 'location-status level-4';
      statusEl.textContent = '📍 الموقع التفصيلي مش متاح حاليًا.';
    }
    if (textEl && verdict.location) {
      textEl.hidden = false;
      textEl.textContent = 'المنطقة: ' + verdict.location;
    }
    if (ctaEl) {
      ctaEl.hidden = false;
      ctaEl.classList.add('big');
      ctaEl.target = '_blank';
      ctaEl.rel = 'noopener noreferrer';
      ctaEl.href = buildExactLocationWaUrl(section.dataset.title || document.title);
      ctaEl.textContent = '📲 تواصل مع طارق للموقع الدقيق';
    }
  }

  async function initPropertyMap(section) {
    if (!section) return;
    const verdict = detectLocationAccuracy({
      location: section.dataset.location || '',
      gpsLat: parseFloat(section.dataset.gpsLat),
      gpsLng: parseFloat(section.dataset.gpsLng),
    });

    const statusEl = section.querySelector('.location-status');
    const mapEl = section.querySelector('.location-map');
    const textEl = section.querySelector('.location-text');
    const ctaEl = section.querySelector('.map-cta');
    const title = section.dataset.title || document.title;

    /* المستوى 4 — بدون خريطة خالص */
    if (verdict.level === 4) { renderLevel4(section, verdict); return; }

    /* المستويات 1-3 — تحميل كسول عند اقتراب القسم من الشاشة */
    lazyWhenVisible(section, async () => {
      try {
        let lat, lng, zoom = 16;

        if (verdict.level === 1) {
          lat = verdict.lat; lng = verdict.lng; zoom = 17;
        } else {
          const streetName = verdict.street || extractStreetPhrase(verdict.location);
          const query = (streetName || verdict.location) + '، مدينة نصر، القاهرة';
          const hit = (verdict.street && staticCoordFor(verdict.street)
            ? { lat: staticCoordFor(verdict.street)[0], lng: staticCoordFor(verdict.street)[1] }
            : await forwardGeocodeVerified(query, streetName || verdict.location));
          if (!hit) { renderLevel4(section, verdict); return; }  // فشل الجيوكودينج → مستوى 4
          lat = hit.lat; lng = hit.lng;
          zoom = verdict.level === 2 ? 16 : 14;
        }

        mapEl.hidden = false;
        const { L, map } = await createMap(mapEl, { center: [lat, lng], zoom, scrollZoom: false });

        if (verdict.level === 1) {
          /* ✅ الموقع الدقيق — pin ذهبي بدون أي تنويه */
          L.marker([lat, lng], { icon: goldPin(L), title: 'الموقع الدقيق' })
            .addTo(map).bindPopup('✅ الموقع الدقيق');
          statusEl.className = 'location-status level-1';
          statusEl.textContent = '✅ الموقع الدقيق';
          if (ctaEl) ctaEl.hidden = true;

        } else if (verdict.level === 2) {
          /* pin ذهبي + تنويه صغير — الاسم بالرقم */
          L.marker([lat, lng], { icon: goldPin(L), title: 'موقع تقريبي' })
            .addTo(map).bindPopup('موقع تقريبي');
          statusEl.className = 'location-status level-2';
          statusEl.textContent = 'الموقع تقريبي — للتأكيد تواصل مع طارق';
          if (textEl) {
            textEl.hidden = false;
            textEl.textContent = verdict.location;   // اسم الشارع + رقم العمارة
          }
          if (ctaEl) ctaEl.hidden = true;

        } else {
          /* دائرة شفافة 500م بدل الـ pin + تنويه برتقالي + CTA */
          const circle = L.circle([lat, lng], {
            radius: 500,
            color: '#d4af37', weight: 2, dashArray: '6 6',
            fillColor: '#d4af37', fillOpacity: 0.16,
          }).addTo(map).bindPopup('نطاق تقريبي 500م حول الشارع');
          try { map.fitBounds(circle.getBounds().pad(0.05)); } catch (_) {}
          statusEl.className = 'location-status level-3';
          statusEl.textContent = 'الخريطة بتوضح الشارع — مش المكان بالظبط';
          if (ctaEl) {
            ctaEl.hidden = false;
            ctaEl.target = '_blank';
            ctaEl.rel = 'noopener noreferrer';
            ctaEl.href = buildExactLocationWaUrl(title);
            ctaEl.textContent = '📲 ابعت لطارق يعرفك المكان بالظبط';
          }
        }
      } catch (err) {
        /* فشل تحميل الخريطة نفسها → نفس معاملة المستوى 4 */
        renderLevel4(section, verdict);
      }
    });
  }

  /* ═══ 11) صفحة المكتب — initOfficeMap (إحداثيات ثابتة) ═══ */

  async function initOfficeMap(section) {
    if (!section) return;
    const lat = parseFloat(section.dataset.lat);
    const lng = parseFloat(section.dataset.lng);
    const mapEl = section.querySelector('.office-map');
    if (!mapEl) return;
    if (!validGps(lat, lng)) {
      mapEl.hidden = true;
      return;
    }
    lazyWhenVisible(section, async () => {
      try {
        const { L, map } = await createMap(mapEl, { center: [lat, lng], zoom: 17, scrollZoom: false });
        L.marker([lat, lng], {
          icon: goldPin(L, { office: true, cls: 'semsar-pin-office' }),
          title: 'مكتب سمسار طلبك',
        }).addTo(map).bindPopup('🏢 مكتب سمسار طلبك');
      } catch (_) {
        mapEl.hidden = true;
      }
    });
  }

  /* ═══ 12) الإقلاع ═══ */

  function boot() {
    initPropertyMap(document.getElementById('property-location'));
    initOfficeMap(document.getElementById('office-location'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  /* الواجهة العامة — بيستخدمها agent.html (منتقي الموقع) */
  window.SemsarMaps = {
    ensureLeaflet,
    createMap,
    goldPin,
    normAr,
    detectLocationAccuracy,
    initPropertyMap,
    initOfficeMap,
    reverseGeocode,
    forwardGeocodeVerified,
    buildExactLocationWaUrl,
    NASR_CENTER,
    validGps,
  };

})(window, document);
