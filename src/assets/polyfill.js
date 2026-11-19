/**
 * Minimal stand-in for Mozilla's `webextension-polyfill` shipped by crx2xpi.
 *
 * WHY this exists: Chromium extensions are written against the callback-based
 * `chrome.*` API, while Firefox exposes the promise-based `browser.*` API.
 * Converted add-ons frequently call `browser.*` directly, which is `undefined`
 * on Chromium-derived runtimes unless something bridges the two namespaces.
 * The real webextension-polyfill does this in full fidelity; this mock keeps
 * the conversion pipeline testable end to end until the bundled dependency
 * lands in the packaging phase.
 *
 * Guarantees of the mock: `browser.*` is populated from `chrome.*`, and every
 * callback-style method is wrapped so callers receive a Promise instead of
 * having to pass a callback. Namespaces unknown to the mock are copied
 * verbatim so nothing is lost. When the runtime already provides a real
 * `browser` object (Firefox), the script is a no-op.
 */
(function (global) {
  'use strict';

  // Firefox exposes the promise-based API natively; bridging is only needed
  // where a `chrome` object exists and `browser` does not.
  if (global.browser && global.browser.runtime && global.browser.runtime.id) {
    return;
  }
  if (!global.chrome) {
    return;
  }

  function wrapMethod(namespace, methodName) {
    return function () {
      const args = Array.prototype.slice.call(arguments);
      return new Promise(function (resolve, reject) {
        args.push(function (result) {
          const lastError = global.chrome.runtime && global.chrome.runtime.lastError;
          if (lastError) {
            reject(new Error(lastError.message));
            return;
          }
          resolve(result);
        });
        try {
          namespace[methodName].apply(namespace, args);
        } catch (err) {
          reject(err);
        }
      });
    };
  }

  const browser = {};
  Object.keys(global.chrome).forEach(function (namespaceName) {
    const namespace = global.chrome[namespaceName];
    if (namespace === null || typeof namespace !== 'object') {
      browser[namespaceName] = namespace;
      return;
    }
    const bridge = {};
    Object.keys(namespace).forEach(function (methodName) {
      const value = namespace[methodName];
      bridge[methodName] = typeof value === 'function' ? wrapMethod(namespace, methodName) : value;
    });
    browser[namespaceName] = bridge;
  });

  global.browser = browser;
})(globalThis);
