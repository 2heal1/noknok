// Viewer capabilities must never become invitation capabilities, including when
// an invitation appears in a name, context, message, preview or nested event.
export function redactInvitations(value) {
  if (typeof value === 'string') {
    return value
      .replace(/\bnk_(?:agent|account|beta)_[A-Za-z0-9_-]{24,256}\b/g, '[redacted credential]')
      .replace(/\bnk1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted contact credential]')
      .replace(/\bwhsec_[A-Za-z0-9+/]+={0,2}/g, '[redacted webhook secret]')
      .replace(/noknok:\/\/invite\/[A-Za-z0-9_-]+/g, '[redacted invitation]')
      .replace(/noknok:\/\/contact\/[A-Za-z0-9_-]+/g, '[redacted contact invitation]')
      // Quotes are valid in some URL origins and query values. Treat the full
      // non-whitespace span as a candidate; removing trailing punctuation is
      // preferable to exposing a capability after an embedded quote.
      .replace(/https?:\/\/\S+/gi, candidate => {
        try {
          const parsed = new URL(candidate);
          return (/^\/invite\/[A-Za-z0-9_-]+$/.test(parsed.pathname) && parsed.searchParams.has('key'))
            || (/^\/meeting\/?$/.test(parsed.pathname) && new URLSearchParams(parsed.hash.slice(1)).has('invite'))
            || (/^\/contact$/.test(parsed.pathname) && new URLSearchParams(parsed.hash.slice(1)).has('offer'))
            ? '[redacted invitation]' : candidate;
        } catch { return candidate; }
      });
  }
  if (Array.isArray(value)) return value.map(redactInvitations);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactInvitations(item)]));
  return value;
}
