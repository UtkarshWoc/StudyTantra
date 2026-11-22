import axios from 'axios';

const envUrl = (import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');
// The Render backend is our production host (supporting full 10MB uploads without Vercel serverless 4.5MB limits).
// If VITE_API_URL is empty or still pointing to the deprecated Vercel serverless backend, use Render.
const RENDER_BACKEND_URL = 'https://studytantra-mern-1.onrender.com';
const rawApiUrl = (!envUrl || envUrl.includes('study-tantra-backend.vercel.app'))
  ? (import.meta.env.PROD ? RENDER_BACKEND_URL : 'http://localhost:5000')
  : envUrl;

export const API_BASE = rawApiUrl ? `${rawApiUrl}/api` : '/api';

if (import.meta.env.PROD && !rawApiUrl) {
  console.warn(
    '[api] VITE_API_URL is not set. API calls will go to this origin under /api; ' +
    'set VITE_API_URL or add a proxy rewrite in vercel.json.'
  );
}

// The access token lives only in memory (never localStorage) so XSS can't
// exfiltrate a long-lived credential. The refresh token is an httpOnly cookie.
let accessToken = null;
let onSessionExpired = () => {};

export const setAccessToken = (token) => { accessToken = token; };
export const getAccessToken = () => accessToken;
export const setSessionExpiredHandler = (fn) => { onSessionExpired = fn; };

// Default timeout for every request. Render free tier can take up to ~50 s to
// warm up from spin-down; we give it 90 s so the spinner stays alive instead of
// producing a silent "Network Error". Callers that need a different limit can
// pass { timeout: N } in their own request config.
export const api = axios.create({ baseURL: API_BASE, withCredentials: true, timeout: 90_000 });

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) config.headers['X-Timezone'] = tz;
  } catch {
    // Ignore environments where Intl timezone is unavailable or fails
  }
  return config;
});

let refreshPromise = null;

/**
 * Exchange the refresh cookie for a new access token. Concurrent callers share
 * one request so a burst of 401s triggers a single refresh.
 */
export const refreshSession = () => {
  refreshPromise ??= axios
    .post(`${API_BASE}/auth/refresh`, null, { withCredentials: true })
    .then(({ data }) => {
      accessToken = data.accessToken;
      return data;
    })
    .finally(() => { refreshPromise = null; });
  return refreshPromise;
};

// Credential endpoints report their own 401s (e.g. wrong password) to the form.
const NO_REFRESH = /\/auth\/(login|register|refresh|logout|google|forgot-password|reset-password|verify-email)$/;

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const { config, response } = error;
    // Automatic retry on 503 (Render free tier spin-up takes ~50s)
    if (response?.status === 503 && config && (config._retry503Count || 0) < 3) {
      config._retry503Count = (config._retry503Count || 0) + 1;
      const delay = config._retry503Count * 3000;
      await new Promise((r) => setTimeout(r, delay));
      return api(config);
    }
    if (response?.status === 401 && config && !config._retried && !NO_REFRESH.test(config.url || '')) {
      config._retried = true;
      try {
        await refreshSession();
        return api(config);
      } catch {
        accessToken = null;
        onSessionExpired();
      }
    }
    return Promise.reject(error);
  }
);

export const getErrorMessage = (error, fallback = 'Something went wrong. Please try again.') => {
  const data = error?.response?.data;
  if (data?.message) return data.message;
  if (typeof data === 'string' && data.length < 300) {
    try {
      const parsed = JSON.parse(data);
      if (parsed.message) return parsed.message;
    } catch {
      return data;
    }
  }
  if (error?.message === 'Network Error' || error?.code === 'ERR_NETWORK') {
    return 'Network Error: Unable to reach the server. Please check your internet connection or verify the deployed backend is active.';
  }
  return error?.message || fallback;
};

/**
 * fetch() with the same auth + refresh behaviour, for streaming responses
 * (axios can't stream in the browser).
 */
export const authFetch = async (path, init = {}) => {
  const doFetch = () => fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { ...(init.headers || {}), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) },
  });
  let res = await doFetch();
  if (res.status === 401) {
    try {
      await refreshSession();
      res = await doFetch();
    } catch {
      accessToken = null;
      onSessionExpired();
    }
  }
  return res;
};
