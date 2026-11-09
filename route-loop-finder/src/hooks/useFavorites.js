import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteFavorite, loadFavorites, saveFavorite } from '../utils/generationsDb';
import { routeKey } from '../utils/routeIdentity';

/**
 * Favorite routes, across every generation: key (utils/routeIdentity) ->
 * { key, path, pathSetId, setName, start, createdAt }. A route is a favorite
 * wherever it turns up again (another generation, the other way round), and
 * a favorite keeps its own copy of the route, so it outlives its generation.
 * Saved in the browser (IndexedDB) as it changes; loaded at start.
 */
export function useFavorites() {
    const [favorites, setFavorites] = useState(() => new Map());
    const favoritesRef = useRef(favorites);
    favoritesRef.current = favorites;

    useEffect(() => {
        let cancelled = false;
        loadFavorites().then((rows) => {
            if (cancelled) return;
            setFavorites((prev) => {
                const next = new Map(rows.filter((r) => r?.key && r.path).map((r) => [r.key, r]));
                prev.forEach((record, key) => next.set(key, record)); // made before the load finished
                return next;
            });
        });
        return () => { cancelled = true; };
    }, []);

    const isFavorite = useCallback((path) => {
        const key = routeKey(path);
        return !!key && favorites.has(key);
    }, [favorites]);

    /**
     * Favorite the route, or unfavorite it when it is one. `source`: the
     * generation it is in ({ id, name, markerPosition }). Returns whether it
     * is a favorite now (null: a route without a line).
     */
    const toggleFavorite = useCallback((path, source = null) => {
        const key = routeKey(path);
        if (!key) return null;
        if (favoritesRef.current.has(key)) {
            setFavorites((prev) => {
                const next = new Map(prev);
                next.delete(key);
                return next;
            });
            deleteFavorite(key);
            return false;
        }
        const record = {
            key,
            path,
            pathSetId: source?.id ?? null,
            setName: source?.name ?? null,
            start: source?.markerPosition ?? null,
            createdAt: Date.now(),
        };
        setFavorites((prev) => new Map(prev).set(key, record));
        saveFavorite(record);
        return true;
    }, []);

    return { favorites, isFavorite, toggleFavorite };
}
