import { useEffect, useRef, useState, useCallback } from 'react';

const RECONNECT_DELAY = 3000;

/**
 * WebSocket hook for real-time communication with the route generation backend.
 * Handles connection, reconnection, and message routing.
 */
/**
 * The backend's address: `/ws` on the site the page came from (wss on https),
 * so one build works on any domain. The Vite dev and preview servers forward
 * `/ws` to the backend (vite.config.js); a deployed site's web server does the
 * same. VITE_WS_URL (e.g. in .env.local) points the UI at another server.
 */
export function defaultSocketUrl(loc = window.location) {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL;
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/ws`;
}

export function useWebSocket(url = defaultSocketUrl()) {
  const ws = useRef(null);
  const messageHandlers = useRef(new Set());
  const reconnectTimeout = useRef(null);
  const [status, setStatus] = useState('disconnected'); // 'connecting' | 'connected' | 'disconnected'

  useEffect(() => {
    // `disposed` and the per-socket checks keep a replaced or unmounted socket
    // (React StrictMode mounts twice in development) from touching state or
    // scheduling reconnects.
    let disposed = false;

    const open = () => {
      if (disposed) return;
      setStatus('connecting');
      const sock = new WebSocket(url);
      ws.current = sock;

      sock.onopen = () => {
        if (ws.current !== sock) return;
        console.log('[WebSocket] Connected');
        setStatus('connected');
      };

      sock.onmessage = (event) => {
        if (ws.current !== sock) return;
        try {
          const data = JSON.parse(event.data);
          messageHandlers.current.forEach(handler => handler(data));
        } catch (error) {
          console.error('[WebSocket] Failed to parse message:', error);
        }
      };

      // A failed connection also fires onclose, which retries; the status dot shows it.
      sock.onerror = () => {
        if (ws.current === sock) console.warn('[WebSocket] Connection error');
      };

      sock.onclose = () => {
        if (ws.current !== sock) return;
        console.log('[WebSocket] Disconnected');
        setStatus('disconnected');
        if (disposed) return;
        reconnectTimeout.current = setTimeout(() => {
          console.log('[WebSocket] Attempting to reconnect...');
          open();
        }, RECONNECT_DELAY);
      };
    };

    open();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimeout.current);
      const sock = ws.current;
      ws.current = null;
      if (!sock) return;
      if (sock.readyState === WebSocket.CONNECTING) {
        // Closing before the handshake logs a browser error; close once open.
        sock.onopen = () => sock.close();
      } else {
        sock.close();
      }
    };
  }, [url]);

  const sendMessage = useCallback((type, payload = {}) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      const message = { type, ...payload };
      ws.current.send(JSON.stringify(message));
      console.log('[WebSocket] Sent:', message);
      return true;
    }
    console.warn('[WebSocket] Cannot send message - not connected');
    return false;
  }, []);

  const subscribe = useCallback((handler) => {
    messageHandlers.current.add(handler);
    return () => messageHandlers.current.delete(handler);
  }, []);

  return { status, sendMessage, subscribe };
}
