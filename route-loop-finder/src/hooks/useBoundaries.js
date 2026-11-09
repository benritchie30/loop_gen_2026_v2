import { useCallback, useEffect, useRef, useState } from 'react';
import { cleanShapes } from '../utils/boundary';

const KEY = 'boundaries';

function read() {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) || '[]');
        return Array.isArray(saved)
            ? saved.filter((b) => b?.id && cleanShapes(b.shapes).length).map((b) => ({ ...b, shapes: cleanShapes(b.shapes) }))
            : [];
    } catch {
        return [];
    }
}

function newId() {
    return `bnd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** The next unused "Boundary n". */
export function nextBoundaryName(boundaries) {
    const used = new Set((boundaries || []).map((b) => b.name));
    let n = (boundaries || []).length + 1;
    while (used.has(`Boundary ${n}`)) n += 1;
    return `Boundary ${n}`;
}

/**
 * Saved search boundaries (utils/boundary.js), kept in the browser
 * (localStorage, they are small): [{ id, name, shapes, createdAt }].
 */
export function useBoundaries() {
    const [boundaries, setBoundaries] = useState(read);
    const current = useRef(boundaries);
    current.current = boundaries;
    useEffect(() => {
        try {
            localStorage.setItem(KEY, JSON.stringify(boundaries));
        } catch {
            console.warn('Failed to save boundaries');
        }
    }, [boundaries]);

    /** Save (a new one without an id, else replace it); returns what was saved, or null without shapes. */
    const saveBoundary = useCallback((draft) => {
        const shapes = cleanShapes(draft?.shapes);
        if (!shapes.length) return null;
        const list = current.current;
        const old = draft.id ? list.find((b) => b.id === draft.id) : null;
        const saved = {
            id: old?.id || newId(),
            name: (draft.name || '').trim() || old?.name || nextBoundaryName(list),
            shapes,
            createdAt: old?.createdAt || Date.now(),
        };
        const next = old ? list.map((b) => (b.id === old.id ? saved : b)) : [...list, saved];
        current.current = next;
        setBoundaries(next);
        return saved;
    }, []);

    const deleteBoundary = useCallback((id) => {
        const next = current.current.filter((b) => b.id !== id);
        current.current = next;
        setBoundaries(next);
    }, []);

    return { boundaries, saveBoundary, deleteBoundary };
}
