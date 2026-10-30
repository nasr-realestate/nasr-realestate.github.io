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

function authErrorMessage(status, code) {
  if (code === 'invalid_credentials') return 'رمز الدخول غير صحيح.';
  if (status === 403) return 'رُفض الطلب لحماية الجلسة (CSRF/Origin). حدّث الصفحة أو سجّل الدخول مجددًا.';
  return 'الدخول غير مصرح به أو انتهت الجلسة. سجّل الدخول مجددًا.';
}

function apiErrorForResponse(response, payload) {
  const { status } = response;
  const code = payload?.error || '';
  if (status === 429) {
    return new CRMApiError('rate_limit', 'محاولات دخول متكررة. انتظر قليلًا ثم أعد المحاولة.', 429, code || 'too_many_attempts');
  }
  if (status === 401 || status === 403) {
    return new CRMApiError('authentication', authErrorMessage(status, code), status, code || 'authentication_required');
  }
  if (status === 503) {
    return new CRMApiError('configuration', 'خدمة CRM غير مهيأة بعد (يلزم ضبط أسرار المصادقة). لم تُرسل أي بيانات.', status, code || 'service_not_configured');
  }
  if (status === 409) {
    const ownerHint = payload?.conflict_contact_name ? ` (${payload.conflict_contact_name})` : '';
    const message = code === 'duplicate_phone_review'
      ? `هذا الرقم مرتبط بسجل عميل آخر${ownerHint}؛ راجع ملكية الرقم قبل المتابعة.`
      : 'تعارض في الطلب؛ راجع السجل ولم يتم الدمج تلقائيًا.';
    const err = new CRMApiError('conflict', message, status, code || 'conflict');
    err.conflictContactId = payload?.conflict_contact_id || '';
    err.conflictContactName = payload?.conflict_contact_name || '';
    return err;
  }
  if (status >= 500) {
    return new CRMApiError('server', 'حدث خطأ بالخدمة. لم يتم تأكيد حفظ الطلب.', status, code || 'server_error');
  }
  return new CRMApiError('validation', code || 'تعذّر قبول البيانات؛ راجع الحقول المطلوبة.', status, code || 'invalid_request');
}

function querySuffix(name, value) {
  return value ? `?${name}=${encodeURIComponent(value)}` : '';
}

export class CRMClient {
  #csrfToken = '';

  constructor({ apiBase = '/api', fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') {
      throw new CRMApiError('configuration', 'ميزة الاتصال غير متاحة في هذا المتصفح.');
    }
    this.apiBase = normalizeBase(apiBase);
    this.fetchImpl = (...args) => fetchImpl(...args);
  }

  hasCsrfToken() {
    return Boolean(this.#csrfToken);
  }

  clearSession() {
    this.#csrfToken = '';
  }

  async request(path, { method = 'GET', body, idempotencyKey, signal, includeCsrf = true } = {}) {
    const headers = { accept: 'application/json' };
    const init = { method, headers, credentials: 'same-origin', cache: 'no-store', redirect: 'follow', signal };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    if (includeCsrf && method !== 'GET' && method !== 'HEAD' && this.#csrfToken) {
      headers['x-crm-csrf'] = this.#csrfToken;
    }

    let response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, init);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new CRMApiError('offline', 'تعذّر الاتصال بالخدمة. تحقق من الاتصال ثم أعد المحاولة.');
    }

    const contentType = response.headers?.get?.('content-type') || '';
    if (response.redirected || !contentType.toLowerCase().includes('application/json')) {
      this.#csrfToken = '';
      throw new CRMApiError('authentication', 'تعذّر التحقق من جلسة الدخول. أعد تحميل الصفحة وسجّل الدخول مجددًا.');
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new CRMApiError('protocol', 'استجابة الخادم غير قابلة للقراءة.', response.status);
    }

    if (!response.ok) {
      if (response.status === 401 && path !== '/auth/login') this.#csrfToken = '';
      throw apiErrorForResponse(response, payload);
    }
    return payload;
  }

  async getSession() {
    const session = await this.request('/auth/session');
    this.#csrfToken = typeof session.csrf_token === 'string' ? session.csrf_token : '';
    return session;
  }

  async login(accessCode) {
    const session = await this.request('/auth/login', {
      method: 'POST',
      body: { access_code: accessCode },
      includeCsrf: false,
    });
    this.#csrfToken = typeof session.csrf_token === 'string' ? session.csrf_token : '';
    return session;
  }

  async logout() {
    try {
      return await this.request('/auth/logout', { method: 'POST', body: {} });
    } finally {
      this.#csrfToken = '';
    }
  }

  getDashboard(day) {
    const query = day ? `?day=${encodeURIComponent(day)}` : '';
    return this.request(`/dashboard${query}`);
  }

  searchContacts(query = '', track = '') {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (track) params.set('track', track);
    const suffix = params.size ? `?${params.toString()}` : '';
    return this.request(`/contacts${suffix}`);
  }

  getContact(contactId) {
    return this.request(`/contacts/${safeId(contactId)}`);
  }

  createContact(contact, idempotencyKey = crypto.randomUUID()) {
    return this.request('/contacts', { method: 'POST', body: contact, idempotencyKey });
  }

  addPhone(contactId, phone) {
    return this.request(`/contacts/${safeId(contactId)}/phones`, { method: 'POST', body: phone });
  }

  updatePhone(contactId, phoneId, payload) {
    return this.request(`/contacts/${safeId(contactId)}/phones/${safeId(phoneId)}`, { method: 'PATCH', body: payload });
  }

  deletePhone(contactId, phoneId, promotePhoneId = '') {
    const suffix = promotePhoneId ? `?promote_phone_id=${safeId(promotePhoneId)}` : '';
    return this.request(`/contacts/${safeId(contactId)}/phones/${safeId(phoneId)}${suffix}`, { method: 'DELETE' });
  }

  updateContact(contactId, payload) {
    return this.request(`/contacts/${safeId(contactId)}`, { method: 'POST', body: payload });
  }

  getFollowups() {
    return this.request('/followups');
  }

  searchConversations({ matchStatus = '', contactId = '', q = '' } = {}) {
    const params = new URLSearchParams();
    if (matchStatus) params.set('match_status', matchStatus);
    if (contactId) params.set('contact_id', contactId);
    if (q) params.set('q', q);
    const suffix = params.size ? `?${params.toString()}` : '';
    return this.request(`/conversations${suffix}`);
  }

  getConversation(conversationId) {
    return this.request(`/conversations/${safeId(conversationId)}`);
  }

  importConversation(payload) {
    return this.request('/conversations/import', { method: 'POST', body: payload });
  }

  linkConversationToContact(conversationId, payload) {
    return this.request(`/conversations/${safeId(conversationId)}/link-contact`, { method: 'POST', body: payload });
  }

  resolveSmartAlert(alertId, payload) {
    return this.request(`/alerts/${safeId(alertId)}/resolve`, { method: 'POST', body: payload });
  }

  searchOpportunities(query = '', status = '', { track = '', role = '' } = {}) {
    const params = new URLSearchParams();
    if (query) params.set('q', query);
    if (status) params.set('status', status);
    if (track) params.set('track', track);
    if (role) params.set('role', role);
    const suffix = params.size ? `?${params.toString()}` : '';
    return this.request(`/opportunities${suffix}`);
  }

  getOpportunity(opportunityId) {
    return this.request(`/opportunities/${safeId(opportunityId)}`);
  }

  updateOpportunity(opportunityId, payload) {
    return this.request(`/opportunities/${safeId(opportunityId)}`, { method: 'POST', body: payload });
  }

  getOpportunityMatches(opportunityId) {
    return this.request(`/opportunities/${safeId(opportunityId)}/matches`);
  }

  switchOpportunityTrack(opportunityId, track) {
    return this.request(`/opportunities/${safeId(opportunityId)}/track`, { method: 'POST', body: { track } });
  }

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

  getPushConfig() {
    return this.request('/push/config');
  }

  subscribePush(payload) {
    return this.request('/push/subscribe', { method: 'POST', body: payload });
  }

  unsubscribePush(endpoint) {
    return this.request('/push/unsubscribe', { method: 'POST', body: { endpoint } });
  }

  sendTestPush(endpoint = '') {
    return this.request('/push/test', { method: 'POST', body: { endpoint } });
  }

  checkDuePushNow() {
    return this.request('/push/check-now', { method: 'POST', body: {} });
  }
}
