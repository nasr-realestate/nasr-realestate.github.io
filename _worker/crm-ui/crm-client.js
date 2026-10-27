const MAX_ID_LENGTH = 80;

export class CRMApiError extends Error {
  constructor(kind, message, status = 0, code = '') {
    super(message);
    this.name = 'CRMApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

function normalizeBase(base) {
  const value = String(base || '/api').trim();
  // The CRM UI and API are deliberately same-origin. This avoids an unverified
  // cross-origin Access-cookie flow and prevents a configurable URL exfiltration path.
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('?') || value.includes('#')) {
    throw new CRMApiError('configuration', 'عنوان API غير صالح؛ يلزم مسار محلي على نفس النطاق.');
  }
  let normalized = value;
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return normalized;
}

function safeId(value) {
  const id = String(value || '');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id) || id.length > MAX_ID_LENGTH) {
    throw new CRMApiError('validation', 'معرّف السجل غير صالح.');
  }
  return encodeURIComponent(id);
}

function apiErrorForResponse(response, payload) {
  const { status } = response;
  const code = payload?.error || '';
  if (status === 401 || status === 403) return new CRMApiError('authentication', 'الدخول غير مصرح به أو انتهت الجلسة. سجّل الدخول مجددًا.', status, code || 'authentication_required');
  if (status === 503) return new CRMApiError('configuration', 'خدمة CRM غير مهيأة بعد. لم تُرسل أي بيانات.', status, code || 'service_not_configured');
  if (status === 409) {
    const message = code === 'duplicate_phone_review' ? 'هذا الرقم مرتبط بسجل آخر؛ راجع بيانات العميل قبل المتابعة.' : 'تعارض في الطلب؛ راجع السجل ولم يتم الدمج تلقائيًا.';
    return new CRMApiError('conflict', message, status, code || 'conflict');
  }
  if (status >= 500) return new CRMApiError('server', 'حدث خطأ بالخدمة. لم يتم تأكيد حفظ الطلب.', status, code || 'server_error');
  return new CRMApiError('validation', code || 'تعذّر قبول البيانات؛ راجع الحقول المطلوبة.', status, code || 'invalid_request');
}

function querySuffix(name, value) {
  return value ? `?${name}=${encodeURIComponent(value)}` : '';
}

export class CRMClient {
  constructor({ apiBase = '/api', fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new CRMApiError('configuration', 'ميزة الاتصال غير متاحة في هذا المتصفح.');
    this.apiBase = normalizeBase(apiBase);
    this.fetchImpl = fetchImpl;
  }

  async request(path, { method = 'GET', body, idempotencyKey, signal } = {}) {
    const headers = { accept: 'application/json' };
    const init = { method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'follow', signal };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

    let response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, init);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new CRMApiError('offline', 'تعذّر الاتصال بالخدمة. تحقق من الاتصال ثم أعد المحاولة.');
    }

    const contentType = response.headers?.get?.('content-type') || '';
    if (response.redirected || !contentType.toLowerCase().includes('application/json')) {
      throw new CRMApiError('authentication', 'تعذّر التحقق من جلسة الدخول. أعد تحميل الصفحة وسجّل الدخول عبر بوابة الوصول.');
    }
    let payload;
    try { payload = await response.json(); }
    catch { throw new CRMApiError('protocol', 'استجابة الخادم غير قابلة للقراءة.', response.status); }

    if (!response.ok) throw apiErrorForResponse(response, payload);
    return payload;
  }

  getDashboard(day) {
    const query = day ? `?day=${encodeURIComponent(day)}` : '';
    return this.request(`/dashboard${query}`);
  }

  searchContacts(query = '') {
    return this.request(`/contacts${querySuffix('q', query)}`);
  }

  getContact(contactId) { return this.request(`/contacts/${safeId(contactId)}`); }

  createContact(contact, idempotencyKey = crypto.randomUUID()) {
    return this.request('/contacts', { method: 'POST', body: contact, idempotencyKey });
  }

  addPhone(contactId, phone) {
    return this.request(`/contacts/${safeId(contactId)}/phones`, { method: 'POST', body: phone });
  }

  searchOpportunities(query = '', status = '') {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (status) params.set('status', status);
    const suffix = params.size ? `?${params.toString()}` : '';
    return this.request(`/opportunities${suffix}`);
  }

  getOpportunity(opportunityId) { return this.request(`/opportunities/${safeId(opportunityId)}`); }

  createOpportunity(opportunity, idempotencyKey = crypto.randomUUID()) {
    return this.request('/opportunities', { method: 'POST', body: opportunity, idempotencyKey });
  }

  addActivity(opportunityId, activity) {
    return this.request(`/opportunities/${safeId(opportunityId)}/activities`, { method: 'POST', body: activity });
  }

  searchListings(query = '') {
    return this.request(`/listings${querySuffix('q', query)}`);
  }

  linkProperty(opportunityId, propertyEvent) {
    return this.request(`/opportunities/${safeId(opportunityId)}/properties`, { method: 'POST', body: propertyEvent });
  }
}
