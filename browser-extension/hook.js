(() => {
  const ENDPOINT = '/api/v4/item/get';
  const EVENT_TYPE = 'SPTRACKING_SHOPEE_ITEM';

  function publish(payload, transport, url) {
    try {
      window.postMessage({
        type: EVENT_TYPE,
        transport,
        url: String(url || ''),
        payload
      }, '*');
    } catch (_) {}
  }

  const nativeFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await nativeFetch.apply(this, args);
    try {
      const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (requestUrl && String(requestUrl).includes(ENDPOINT)) {
        response.clone().json().then((data) => publish(data, 'fetch', requestUrl)).catch(() => {});
      }
    } catch (_) {}
    return response;
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__sptrackingUrl = url;
    return nativeOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    try {
      if (this.__sptrackingUrl && String(this.__sptrackingUrl).includes(ENDPOINT)) {
        this.addEventListener('loadend', () => {
          try {
            const text = typeof this.responseText === 'string' ? this.responseText : '';
            if (!text) return;
            publish(JSON.parse(text), 'xhr', this.__sptrackingUrl);
          } catch (_) {}
        }, { once: true });
      }
    } catch (_) {}
    return nativeSend.apply(this, args);
  };
})();
