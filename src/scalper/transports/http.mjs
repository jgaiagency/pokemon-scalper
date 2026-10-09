function headerEntries(headers) {
  if (!headers) return {};
  if (typeof headers.entries === 'function') return Object.fromEntries(headers.entries());
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function extractJsonLd(html) {
  // Extract JSON-LD Product objects from HTML (Best Buy embeds availability in
  // script[type="application/ld+json"] rather than a JSON API).
  const matches = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of matches) {
    try {
      const data = JSON.parse(match[1]);
      if (data?.['@type'] === 'Product') return data;
    } catch { /* Keep scanning. */ }
  }
  return null;
}

async function parseResponse(response) {
  const headers = headerEntries(response.headers);
  const body = await response.text();
  const result = { status: response.status, headers, body, ...(response.url ? { url: response.url } : {}) };
  const contentType = headers['content-type'] ?? '';
  if (/\b(?:application|text)\/[\w.+-]*json\b/i.test(contentType) || /\+json\b/i.test(contentType)) {
    try { result.bodyJson = JSON.parse(body); } catch { /* Keep invalid JSON as text for diagnostics. */ }
  } else if (/\btext\/html\b/i.test(contentType) || /\bhtml\b/i.test(contentType)) {
    const jsonLd = extractJsonLd(body);
    if (jsonLd) result.bodyJson = jsonLd;
  }
  return result;
}

export function createHttpTransport({ fetch: fetchFunction = globalThis.fetch } = {}) {
  if (typeof fetchFunction !== 'function') throw new Error('A fetch implementation is required');

  const request = async ({ method = 'GET', url, headers, body, signal, redirect } = {}) => {
    if (!url) throw new Error('HTTP request URL is required');
    const response = await fetchFunction(url, { method, headers, body, signal, redirect });
    return parseResponse(response);
  };

  return {
    request,
    get(url, { signal, headers, redirect } = {}) {
      return request({ method: 'GET', url, signal, headers, redirect });
    },
    postJson(url, body, { signal, headers } = {}) {
      return request({
        method: 'POST', url, signal,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    },
  };
}
