/* Availability invitation: no request, tracking, auto-opening or status changes.
   Reveal only after two continuous seconds in the visible description area.
   sessionStorage stores a seen flag per property, never personal information. */
(function () {
  'use strict';
  var prompt = document.querySelector('[data-availability-prompt]');
  if (!prompt) return;
  var property = prompt.getAttribute('data-property');
  var close = prompt.querySelector('[data-availability-close]');
  if (!property || !close) return;

  var key = 'smsar:availability:' + property;
  var shown = false;
  var inView = false;
  var timer = null;
  var observer = null;

  function seen() {
    try { return window.sessionStorage.getItem(key) === '1'; }
    catch (e) { return false; }
  }
  function remember() {
    try { window.sessionStorage.setItem(key, '1'); }
    catch (e) { /* Blocked storage: still once per document. */ }
  }
  function cancel() {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }
  function stopObserving() {
    cancel();
    if (observer) observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
  }
  function dismiss() {
    shown = true;
    remember();
    stopObserving();
    // A user action may collapse the card; the automatic reveal never changes
    // its dimensions, shifts the description or moves keyboard focus.
    prompt.hidden = true;
  }
  function reveal() {
    timer = null;
    if (shown || !inView || document.visibilityState === 'hidden') return;
    if (seen()) { prompt.hidden = true; stopObserving(); return; }
    shown = true;
    remember();
    prompt.classList.add('is-visible');
    var message = prompt.querySelector('[data-availability-message]');
    if (message) {
      var text = message.textContent;
      message.textContent = '';
      message.textContent = text; // Announce politely without changing layout.
    }
    stopObserving();
  }
  function schedule() {
    cancel();
    if (!shown && inView && document.visibilityState !== 'hidden') {
      timer = window.setTimeout(reveal, 2000);
    }
  }
  function onVisibility() { schedule(); }

  function closePrompt() {
    var description = prompt.closest('.pp-description');
    dismiss();
    if (!description) return;
    var hadTabIndex = description.hasAttribute('tabindex');
    if (!hadTabIndex) description.setAttribute('tabindex', '-1');
    description.focus({ preventScroll: true });
    if (!hadTabIndex) description.addEventListener('blur', function () {
      description.removeAttribute('tabindex');
    }, { once: true });
  }

  // This is a reminder for the existing inquiry flow, not a second action.
  // Once the visitor uses an inquiry button, do not remind them to ask again.
  document.querySelectorAll('#ppWaBtn, .pp-agent-btn, .pp-floating-wa').forEach(function (link) {
    link.addEventListener('click', dismiss); // Never cancel navigation or analytics.
  });
  close.addEventListener('click', closePrompt);
  prompt.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || !shown) return;
    event.preventDefault();
    closePrompt();
  });

  if (seen()) { prompt.hidden = true; return; }
  if (!('IntersectionObserver' in window)) {
    // Older browsers get an ordinary inline invitation, not an early popup.
    prompt.classList.add('is-visible');
    return;
  }
  observer = new window.IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.target !== prompt) return;
      inView = entry.isIntersecting && entry.intersectionRatio >= 0.25;
      schedule();
    });
  }, { threshold: [0, 0.25] });
  document.addEventListener('visibilitychange', onVisibility);
  observer.observe(prompt);
})();
