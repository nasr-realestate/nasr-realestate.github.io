/* Free interactive maps for Semsar Talabak: Leaflet + OSM + Photon/Nominatim. */
(function (window, document) {
  'use strict';

  let leafletPromise;

  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      script.onload = () => resolve(window.L);
      script.onerror = () => {
        script.remove();
        const fallback = document.createElement('script');
        fallback.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js';
        fallback.onload = () => resolve(window.L);
        fallback.onerror = () => reject(new Error('تعذر تحميل مكتبة الخرائط'));
        document.head.appendChild(fallback);
        css.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css';
      };
      document.head.appendChild(script);
    });
    return leafletPromise;
  }

  async function requestJson(url, timeoutMs = 7000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' }
      });
      if (!response.ok) throw new Error(`Geocoding HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function geocodeAddress(address) {
    const query = `${address}, Cairo, Egypt`;
    try {
      const data = await requestJson(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=1&lang=ar`);
      const feature = data.features && data.features[0];
      if (feature && feature.geometry && feature.geometry.coordinates) {
        return { lat: feature.geometry.coordinates[1], lon: feature.geometry.coordinates[0], properties: feature.properties || {} };
      }
    } catch (_) { /* Nominatim is the free fallback. */ }
    try {
      const data = await requestJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`);
      if (data && data[0]) return { lat: Number(data[0].lat), lon: Number(data[0].lon), properties: data[0] };
    } catch (_) { /* The UI will fall back to the no-map CTA. */ }
    return null;
  }

  async function reverseGeocode(lat, lon) {
    try {
      const data = await requestJson(`https://photon.komoot.io/reverse?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&lang=ar`);
      const feature = data.features && data.features[0];
      if (feature) return formatAddress(feature.properties || {});
    } catch (_) { /* Fall through to Nominatim. */ }
    try {
      const data = await requestJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&accept-language=ar`);
      if (data && data.address) return data.display_name || formatAddress(data.address);
    } catch (_) { /* Caller may enter a location manually. */ }
    return '';
  }

  function formatAddress(p) {
    return [p.name, p.street, p.housenumber, p.suburb, p.district, p.city_district, p.city, p.state]
      .filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join('، ');
  }

  function isBroadArea(text) {
    const normalized = String(text || '').trim();
    if (!normalized) return true;
    const street = /(شارع|طريق|ميدان|محور|street|road|avenue|st\.?\b)/i.test(normalized);
    const building = /(عمارة|عقار رقم|رقم\s*[٠-٩\d]|[٠-٩]|\b\d{1,4}\b)/i.test(normalized);
    const district = /(مدينة نصر|القاهرة الجديدة|مصر الجديدة|الحي|المنطقة|زهراء|الشروق|التجمع|المقطم)/i.test(normalized);
    const onlyAreaName = /^(?:(?:مدينة نصر|القاهرة الجديدة|مصر الجديدة|زهراء مدينة نصر|الشروق|التجمع(?: الخامس)?|المقطم)|(?:الحي|المنطقة)\s*[\u0600-\u06FF٠-٩0-9\s-]*)(?:\s*[-،,]\s*(?:مدينة نصر|القاهرة الجديدة|مصر الجديدة))?$/i.test(normalized);
    return district && !street && !building && (onlyAreaName || normalized.length < 25);
  }

  function hasBuildingNumber(text) {
    return /(عمارة|عقار|رقم|[٠-٩]|\b\d{1,4}\b)/i.test(String(text || ''));
  }

  function makeWhatsApp(message) {
    return `https://wa.me/201147758857?text=${encodeURIComponent(message)}`;
  }

  function addOsmTiles(map) {
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>'
    }).addTo(map);
  }

  async function initPropertyMap() {
    const section = document.getElementById('property-location-map');
    if (!section) return;
    const address = section.dataset.location || '';
    const title = section.dataset.title || document.title;
    const exactLat = Number(section.dataset.latitude);
    const exactLon = Number(section.dataset.longitude);
    const hasStoredGps = section.dataset.latitude !== '' && section.dataset.longitude !== '' &&
      Number.isFinite(exactLat) && Number.isFinite(exactLon) &&
      exactLat >= -90 && exactLat <= 90 && exactLon >= -180 && exactLon <= 180;
    const status = section.querySelector('.map-status');
    const mapNode = section.querySelector('.map-canvas');
    const cta = section.querySelector('.map-cta');
    const waMessage = `السلام عليكم أ. طارق، مهتم بالعقار: ${title}${address ? ` — الموقع المذكور: ${address}` : ''}. ممكن تفاصيل الموقع؟`;
    cta.href = makeWhatsApp(waMessage);

    if (!hasStoredGps && isBroadArea(address)) {
      status.textContent = 'الموقع منطقة عامة فقط؛ حفاظاً على الدقة لا نعرض دبوساً غير مؤكد.';
      section.classList.add('map-level-broad');
      return;
    }
    if (!hasStoredGps && !address) {
      status.textContent = 'تفاصيل الموقع غير متاحة حالياً.';
      section.classList.add('map-level-broad');
      return;
    }
    status.textContent = 'جارٍ تحديد الموقع تقريبياً…';
    try {
      const place = hasStoredGps ? { lat: exactLat, lon: exactLon } : await geocodeAddress(address);
      if (!place || !Number.isFinite(Number(place.lat)) || !Number.isFinite(Number(place.lon))) throw new Error('No result');
      const L = await loadLeaflet();
      const latlng = [Number(place.lat), Number(place.lon)];
      const map = L.map(mapNode, { scrollWheelZoom: false }).setView(latlng, hasStoredGps ? 17 : (hasBuildingNumber(address) ? 16 : 14));
      addOsmTiles(map);
      if (hasStoredGps) {
        const icon = L.divIcon({ className: 'property-gps-pin', html: '<span aria-hidden="true">●</span>', iconSize: [28, 28], iconAnchor: [14, 14] });
        L.marker(latlng, { icon, title: 'الموقع الدقيق' }).addTo(map).bindPopup('الموقع الدقيق');
        status.textContent = 'الموقع الدقيق';
        section.classList.add('map-level-exact');
      } else {
        // Geocoding an address is approximate: show an area, never a fabricated property pin.
        L.circle(latlng, { radius: hasBuildingNumber(address) ? 180 : 500, color: '#d4af37', weight: 2, fillColor: '#d4af37', fillOpacity: 0.17 }).addTo(map);
        status.textContent = hasBuildingNumber(address) ? 'تقريبي — تواصل مع طارق' : 'موقع تقريبي للشارع — ابعت لطارق';
        section.classList.add(hasBuildingNumber(address) ? 'map-level-building' : 'map-level-street');
      }
      setTimeout(() => map.invalidateSize(), 100);
    } catch (_) {
      section.classList.add('map-level-broad');
      status.textContent = 'تعذر تحديد الموقع الآن؛ تواصل مع طارق لمعرفة الموقع.';
    }
  }

  async function initOfficeMap() {
    const section = document.getElementById('office-location-map');
    if (!section) return;
    const address = section.dataset.address || '';
    const status = section.querySelector('.map-status');
    const mapNode = section.querySelector('.map-canvas');
    const link = section.querySelector('.map-cta');
    link.href = `https://www.openstreetmap.org/search?query=${encodeURIComponent(`${address}, Nasr City, Cairo, Egypt}`)}`;
    status.textContent = 'جارٍ تحميل موقع المكتب…';
    try {
      const place = await geocodeAddress(address);
      if (!place) throw new Error('No result');
      const L = await loadLeaflet();
      const center = [Number(place.lat), Number(place.lon)];
      const map = L.map(mapNode, { scrollWheelZoom: false }).setView(center, 16);
      addOsmTiles(map);
      L.circle(center, { radius: 140, color: '#d4af37', weight: 2, fillColor: '#d4af37', fillOpacity: 0.2 }).addTo(map);
      status.textContent = 'موقع المكتب التقريبي — اتصل بنا للتأكيد قبل الزيارة.';
      setTimeout(() => map.invalidateSize(), 100);
    } catch (_) {
      section.classList.add('map-level-broad');
      status.textContent = 'تعذر تحميل الخريطة؛ استخدم رابط البحث في OpenStreetMap.';
    }
  }

  let pickerMap;
  let pickerCircle;
  let pickerMarker;
  let pickerRequest = 0;
  let activeSelection = null;

  function closePicker() {
    const modal = document.getElementById('agent-location-picker');
    if (modal) modal.classList.remove('open');
    activeSelection = null;
  }

  async function openAgentPicker(options = {}) {
    const modal = document.getElementById('agent-location-picker');
    const mapNode = document.getElementById('agent-picker-map');
    const label = document.getElementById('agent-picker-address');
    const manual = document.getElementById('agent-picker-manual');
    const confirm = document.getElementById('agent-picker-confirm');
    if (!modal) return null;
    modal.classList.add('open');
    modal.dataset.required = options.required ? 'true' : 'false';
    document.getElementById('agent-picker-title').textContent = options.required ? 'حدد موقع العقار قبل المتابعة' : 'حدد موقع العقار (اختياري)';
    label.textContent = 'اضغط على الخريطة لتحديد موقع تقريبي؛ لن يتم حفظ الإحداثيات.';
    manual.value = '';
    confirm.disabled = true;
    activeSelection = null;
    try {
      const L = await loadLeaflet();
      if (!pickerMap) {
        // يبدأ العرض دون إحداثيات ثابتة؛ مركز القاهرة يُطلب ديناميكياً في الخلفية.
        pickerMap = L.map(mapNode, { scrollWheelZoom: true }).setView([0, 0], 2);
        addOsmTiles(pickerMap);
        geocodeAddress('مدينة نصر، القاهرة').then(initialPlace => {
          if (initialPlace && pickerMap) pickerMap.setView([Number(initialPlace.lat), Number(initialPlace.lon)], 13);
        }).catch(() => {});
        pickerMap.on('click', async event => {
          const sequence = ++pickerRequest;
          const point = event.latlng;
          activeSelection = { lat: point.lat, lon: point.lng };
          if (pickerMarker) pickerMap.removeLayer(pickerMarker);
          if (pickerCircle) pickerMap.removeLayer(pickerCircle);
          pickerMarker = L.marker(point, { title: 'الموقع الذي اخترته' }).addTo(pickerMap);
          pickerCircle = L.circle(point, { radius: 120, color: '#d4af37', weight: 2, fillColor: '#d4af37', fillOpacity: 0.12 }).addTo(pickerMap);
          label.textContent = 'جارٍ قراءة اسم المنطقة…';
          confirm.disabled = true;
          const address = await reverseGeocode(point.lat, point.lng);
          if (sequence !== pickerRequest) return;
          if (address) {
            activeSelection.label = address;
            manual.value = address;
            label.textContent = `موقع تقريبي: ${address}`;
            confirm.disabled = false;
          } else {
            label.textContent = 'لم ينجح البحث الآلي. اكتب اسم المنطقة أو الشارع يدوياً؛ لن نرسل الإحداثيات.';
          }
        });
      }
      setTimeout(() => pickerMap.invalidateSize(), 150);
    } catch (_) {
      label.textContent = 'تعذر تحميل الخريطة. اكتب اسم المنطقة أو الشارع يدوياً للمتابعة.';
    }
    manual.oninput = () => {
      const text = manual.value.trim();
      if (text.length >= 3) {
        // Text-only fallback is useful when a geocoder or map CDN is unavailable.
        activeSelection = activeSelection || { lat: null, lon: null };
        activeSelection.label = text;
        confirm.disabled = false;
      } else {
        confirm.disabled = true;
      }
    };
    return new Promise(resolve => {
      modal._resolve = resolve;
      document.getElementById('agent-picker-cancel').onclick = () => {
        const done = modal._resolve;
        modal._resolve = null;
        closePicker();
        if (done) done(null);
      };
      confirm.onclick = () => {
        const result = activeSelection && manual.value.trim().length >= 3 ? manual.value.trim() : null;
        const done = modal._resolve;
        modal._resolve = null;
        closePicker();
        if (done) done(result);
      };
    });
  }

  window.SemsarMaps = { loadLeaflet, geocodeAddress, reverseGeocode, initPropertyMap, initOfficeMap, openAgentPicker };
  document.addEventListener('DOMContentLoaded', () => {
    initPropertyMap();
    initOfficeMap();
  });
})(window, document);
