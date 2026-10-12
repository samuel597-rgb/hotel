(function () {
  'use strict';

  var DEPTH_KEY = 'hp_nav_depth';
  var FORWARD_KEY = 'hp_nav_forward';
  var LOG_KEY = 'hp_nav_log';
  var MAX_LOG = 50;

  var depth = 0;
  var forward = 0;
  var log = [];
  var buttons = null;
  var installed = false;

  function readInt(key) {
    var value = parseInt(sessionStorage.getItem(key) || '', 10);
    return isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  function persist() {
    sessionStorage.setItem(DEPTH_KEY, String(depth));
    sessionStorage.setItem(FORWARD_KEY, String(forward));
  }

  function loadLog() {
    var parsed;
    try {
      parsed = JSON.parse(sessionStorage.getItem(LOG_KEY) || '[]');
    } catch (error) {
      return [];
    }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(function (entry) { return typeof entry === 'string'; });
  }

  function saveLog() {
    try {
      sessionStorage.setItem(LOG_KEY, JSON.stringify(log));
    } catch (error) { /* storage unavailable; counters still work */ }
  }

  function locate(href) {
    var best = -1;
    var bestDistance = Infinity;
    for (var i = 0; i < log.length; i++) {
      if (log[i] === href) {
        var distance = Math.abs(i - depth);
        if (distance < bestDistance) {
          best = i;
          bestDistance = distance;
        }
      }
    }
    return best;
  }

  function pushLogEntry(href) {
    log = log.slice(0, depth + 1);
    log.push(href);
    if (log.length > MAX_LOG) log.shift();
    depth = log.length - 1;
    forward = 0;
  }

  function refresh() {
    if (!buttons) return;
    var canBack = depth > 0;
    var canForward = forward > 0;
    buttons.back.disabled = !canBack;
    buttons.back.setAttribute('aria-disabled', String(!canBack));
    buttons.forward.disabled = !canForward;
    buttons.forward.setAttribute('aria-disabled', String(!canForward));
  }

  function reconcile() {
    var href = location.href;
    var index = locate(href);
    if (index === -1) {
      pushLogEntry(href);
    } else {
      depth = index;
      forward = log.length - 1 - index;
    }
    saveLog();
    persist();
    refresh();
  }

  function navigationType() {
    try {
      var entries = performance.getEntriesByType('navigation');
      if (entries && entries.length) return entries[0].type || 'navigate';
    } catch (error) { /* fall through */ }
    try {
      if (performance.navigation) {
        if (performance.navigation.type === 1) return 'reload';
        if (performance.navigation.type === 2) return 'back_forward';
      }
    } catch (error) { /* fall through */ }
    return 'navigate';
  }

  function onLoad() {
    var type = navigationType();
    if (type === 'reload') {
      // Hard refresh: the in-app history starts over here.
      depth = 0;
      forward = 0;
      log = [location.href];
      saveLog();
      persist();
      refresh();
      return;
    }
    if (type === 'back_forward') {
      // Arrived via browser back/forward: reposition from the log.
      reconcile();
      return;
    }
    // Fresh navigation into this document (in-app link click, typed URL,
    // redirect). Same-origin link clicks already updated the counters
    // before the navigation started; keep them and make sure the log
    // knows the current URL.
    var index = locate(location.href);
    if (index === -1) {
      pushLogEntry(location.href);
    } else {
      depth = index;
      forward = log.length - 1 - index;
    }
    saveLog();
    persist();
    refresh();
  }

  function onPopState() {
    reconcile();
  }

  function onHashChange() {
    reconcile();
  }

  function onPageShow(event) {
    if (event.persisted) reconcile();
  }

  function onClick(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var anchor = null;
    var node = event.target;
    while (node && node.nodeType === 1) {
      if (node.tagName === 'A') {
        anchor = node;
        break;
      }
      node = node.parentElement;
    }
    if (!anchor) return;
    if (anchor.target && anchor.target !== '_self') return;
    if (anchor.hasAttribute('download')) return;
    var url;
    try {
      url = new URL(anchor.href, location.href);
    } catch (error) {
      return;
    }
    if (url.origin !== location.origin) return;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (url.pathname === location.pathname && url.search === location.search) {
      // Fragment-only navigation: hashchange records the real entry.
      return;
    }
    pushLogEntry(url.href);
    saveLog();
    persist();
    refresh();
  }

  function onKeydown(event) {
    // Alt+Left / Alt+Right navigate within the app. Ctrl/Cmd+Left/Right
    // are browser shortcuts and must stay untouched.
    if (!event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowLeft') {
      history.back();
    } else if (event.key === 'ArrowRight') {
      history.forward();
    }
  }

  function install() {
    depth = readInt(DEPTH_KEY);
    forward = readInt(FORWARD_KEY);
    log = loadLog();

    var nativePushState = history.pushState;
    history.pushState = function (state, title, url) {
      nativePushState.call(history, state, title, url);
      var href = url ? new URL(String(url), location.href).href : location.href;
      pushLogEntry(href);
      saveLog();
      persist();
      refresh();
    };

    var nativeReplaceState = history.replaceState;
    history.replaceState = function (state, title, url) {
      nativeReplaceState.call(history, state, title, url);
      var href = url ? new URL(String(url), location.href).href : location.href;
      if (log.length) {
        log[depth] = href;
        saveLog();
      }
    };

    addEventListener('popstate', onPopState);
    addEventListener('hashchange', onHashChange);
    addEventListener('pageshow', onPageShow);
    addEventListener('keydown', onKeydown);
    document.addEventListener('click', onClick);

    onLoad();
  }

  function render(target) {
    if (!target) return null;
    if (!installed) {
      installed = true;
      install();
    }
    target.classList.add('hp-nav');
    var back = document.createElement('button');
    back.type = 'button';
    back.className = 'hp-nav-button hp-nav-back';
    back.setAttribute('aria-label', 'Go back');
    back.textContent = '←';
    back.addEventListener('click', function () {
      history.back();
    });
    var forwardButton = document.createElement('button');
    forwardButton.type = 'button';
    forwardButton.className = 'hp-nav-button hp-nav-forward';
    forwardButton.setAttribute('aria-label', 'Go forward');
    forwardButton.textContent = '→';
    forwardButton.addEventListener('click', function () {
      history.forward();
    });
    var divider = document.createElement('span');
    divider.className = 'hp-nav-divider';
    divider.setAttribute('aria-hidden', 'true');
    target.appendChild(back);
    target.appendChild(forwardButton);
    target.appendChild(divider);
    buttons = { back: back, forward: forwardButton };
    refresh();
    return target;
  }

  window.HPNav = { render: render };
})();
