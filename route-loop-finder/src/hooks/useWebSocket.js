import { useEffect, useRef, useState, useCallback } from 'react';

const RECONNECT_DELAY = 3000;

/**
 * WebSocket hook for real-time communication with the route generation backend.
 * Handles connection, reconnection, and message routing.
 */
export function useWebSocket(url = 'ws://localhost:8765') {
  const ws = useRef(null);
  const messageHandlers = useRef(new Set());
  const reconnectTimeout = useRef(null);
  const [status, setStatus] = useState('disconnected'); // 'connecting' | 'connected' | 'disconnected'

  const connect = useCallback(() => {
    if (ws.current?.readyState === WebSocket.OPEN) return;
    
    setStatus('connecting');
    ws.current = new WebSocket(url);

    ws.current.onopen = () => {
      console.log('[WebSocket] Connected');
      setStatus('connected');
    };

    ws.current.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        messageHandlers.current.forEach(handler => handler(data));
      } catch (error) {
        console.error('[WebSocket] Failed to parse message:', error);
      }
    };

    ws.current.onerror = (error) => {
      console.error('[WebSocket] Error:', error);
    };

    ws.current.onclose = () => {
      console.log('[WebSocket] Disconnected');
      setStatus('disconnected');
      
      // Attempt to reconnect
      reconnectTimeout.current = setTimeout(() => {
        console.log('[WebSocket] Attempting to reconnect...');
        connect();
      }, RECONNECT_DELAY);
    };
  }, [url]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeout.current) {
        clearTimeout(reconnectTimeout.current);
      }
      if (ws.current) {
        ws.current.close();
      }
    };
  }, [connect]);

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
