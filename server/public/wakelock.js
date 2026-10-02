// Screen Wake Lock — keeps the display from sleeping while this tab is
// open/visible, so an unattended race (which can run for many hours)
// doesn't lose scans because the host PC's screen locked or dimmed.
//
// Self-contained: no dependency on app.js or any other script on the page.
// Controlled by an optional slide toggle (#wakeLockToggle) in the header;
// the preference is remembered in localStorage across reloads.
(() => {
  const STORAGE_KEY = 'timetaker.wakeLockEnabled';
  const supported = 'wakeLock' in navigator;

  let wakeLock = null;
  let enabled = readStoredPreference();

  function readStoredPreference() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      // Default to on when no preference has been saved yet.
      return stored === null ? true : stored === 'true';
    } catch (error) {
      // localStorage can throw in some locked-down/private-browsing contexts.
      return true;
    }
  }

  function storePreference(value) {
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch (error) {
      // Ignore — worst case the preference just isn't remembered.
    }
  }

  async function requestWakeLock() {
    if (!supported || !enabled || wakeLock) {
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } catch (error) {
      // Not fatal — some browsers reject without a user gesture, or the
      // device/battery state may not allow it. Fail silently and rely on
      // the click fallback / visibility re-acquire below.
      console.warn('Screen wake lock request failed:', error);
    }
  }

  async function releaseWakeLock() {
    if (wakeLock) {
      try {
        await wakeLock.release();
      } catch (error) {
        // Ignore — it may already be released.
      }
      wakeLock = null;
    }
  }

  function setupToggle() {
    const toggle = document.getElementById('wakeLockToggle');
    if (!toggle) {
      return;
    }
    toggle.checked = enabled;
    if (!supported) {
      toggle.disabled = true;
      toggle.title = 'Not supported in this browser';
      return;
    }
    toggle.addEventListener('change', () => {
      enabled = toggle.checked;
      storePreference(enabled);
      if (enabled) {
        requestWakeLock();
      } else {
        releaseWakeLock();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupToggle);
  } else {
    setupToggle();
  }

  if (!supported) {
    console.warn('Screen Wake Lock API is not supported in this browser.');
    return;
  }

  requestWakeLock();

  // The lock is automatically released when the tab is hidden/backgrounded.
  // Re-acquire it whenever the tab becomes visible again (only if the user
  // still has the toggle on).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && enabled && !wakeLock) {
      requestWakeLock();
    }
  });

  // Some browsers only grant the lock after a user gesture. If the
  // automatic request above was rejected, try again on the first click
  // anywhere on the page.
  document.addEventListener('click', () => {
    if (enabled && !wakeLock) {
      requestWakeLock();
    }
  }, { once: true });
})();
