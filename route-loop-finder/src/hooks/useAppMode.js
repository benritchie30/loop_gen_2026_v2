import { useState, useCallback, useEffect } from 'react';

/**
 * Application mode state machine.
 * - 'input': User can drop pins on map and select existing path sets
 * - 'display': User is browsing paths in the active path set
 * - 'drawing': User is drawing on map to select road sections
 */
export function useAppMode() {
    const [mode, setModeState] = useState('input');
    const [pendingMarker, setPendingMarker] = useState(() => {
        const saved = localStorage.getItem('pendingMarker');
        return saved ? JSON.parse(saved) : null;
    });

    // Save pending marker to localStorage whenever it changes
    useEffect(() => {
        if (pendingMarker) {
            localStorage.setItem('pendingMarker', JSON.stringify(pendingMarker));
        } else {
            localStorage.removeItem('pendingMarker');
        }
    }, [pendingMarker]);

    const setMode = useCallback((newMode) => {
        if (['input', 'display', 'drawing'].includes(newMode)) {
            setModeState(newMode);
            // We NO LONGER clear pendingMarker here.
            // It will be hidden by MapView when not in 'input' mode,
            // but will persist for the next time we enter 'input' mode or refresh.
        }
    }, []);

    const setMarkerPosition = useCallback((position) => {
        if (mode === 'input') {
            setPendingMarker(position);
        }
    }, [mode]);

    // Set the start pin whatever the mode (search result, location).
    const placeMarker = useCallback((position) => {
        setPendingMarker(position);
    }, []);

    const clearPendingMarker = useCallback(() => {
        setPendingMarker(null);
    }, []);

    return {
        mode,
        setMode,
        pendingMarker,
        setMarkerPosition,
        placeMarker,
        clearPendingMarker
    };
}
