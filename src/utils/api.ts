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
    throw new Error('Server returned an unexpected non-JSON response.');
  }

  if (!res.ok) {
    const errObj = parsed as { error?: string; message?: string };
    throw new Error(
      errObj?.error || errObj?.message || `Request failed (${res.status})`
    );
  }

  return parsed as T;
}
