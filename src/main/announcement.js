// Fetches the current in-app announcement from the Worker. Fail-silent:
// any network/parse error returns null so the app never breaks over a
// notice. The renderer polls this through the announcement:get IPC.

const { readConfiguredApiBaseUrl } = require('../shared/api-base');

async function fetchAnnouncement() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    let res;
    try {
      res = await fetch(`${readConfiguredApiBaseUrl()}/announcement`, {
        method: 'GET',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body || !body.ok) return null;
    return body.announcement || null; // null = nothing live
  } catch {
    // Offline, Worker down, or dev with no Worker — show nothing.
    return null;
  }
}

module.exports = { fetchAnnouncement };
