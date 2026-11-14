let inflightAuthRefresh: Promise<boolean> | null = null;

export async function refreshAuthBridgeSession(): Promise<boolean> {
  if (inflightAuthRefresh) return inflightAuthRefresh;
  inflightAuthRefresh = (async () => {
    try {
      const res = await fetch('/api/health', {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return false;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) return false;
      const data = (await res.json()) as { ok?: boolean };
      return Boolean(data?.ok);
    } catch {
      return false;
    } finally {
      inflightAuthRefresh = null;
    }
  })();
  return inflightAuthRefresh;
}

export async function safeApiFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = 45_000
): Promise<Response> {
  for (let authAttempt = 0; authAttempt < 2; authAttempt++) {
    const controller = new AbortController();
    const timer =
      timeoutMs > 0
        ? window.setTimeout(() => controller.abort(), timeoutMs)
        : undefined;
    try {
      const res = await fetch(url, {
        ...init,
        credentials: 'include',
        redirect: 'manual',
        signal: init.signal || controller.signal,
      });
      const contentType = res.headers.get('content-type') || '';
      if (
        res.type === 'opaqueredirect' ||
        (authAttempt === 0 && contentType.includes('text/html'))
      ) {
        const refreshed = await refreshAuthBridgeSession();
        if (refreshed && authAttempt === 0) {
          continue;
        }
        throw new Error(
          'Session auth expired — please refresh the page and try again (any video upload will resume automatically).'
        );
      }
      return res;
    } finally {
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    }
  }
  throw new Error(
    'Session auth expired — please refresh the page and try again.'
  );
}

export async function parseJsonResponse<T>(res: Response): Promise<T> {
  const rawText = await res.text();
  let parsed: unknown = null;

  try {
    parsed = rawText ? JSON.parse(rawText) : {};
  } catch {
    if (res.status === 413) {
      throw new Error(
        'File chunk exceeded request limit. Please try again with a smaller file or refresh.'
      );
    }
    if (!res.ok) {
      throw new Error(
        `Server returned HTTP ${res.status}. Please retry in a moment.`
      );
    }
    const trimmed = rawText.trimStart();
    if (trimmed.startsWith('<')) {
      throw new Error(
        'Session or proxy returned an HTML page instead of JSON. Please refresh the page and try again.'
      );
    }
    const ct = res.headers.get('content-type') || 'unknown';
    throw new Error(
      `Server returned an unexpected non-JSON response (HTTP ${res.status}, ${ct}).`
    );
  }

  if (!res.ok) {
    const errObj = parsed as { error?: string; message?: string };
    throw new Error(
      errObj?.error || errObj?.message || `Request failed (${res.status})`
    );
  }

  return parsed as T;
}
