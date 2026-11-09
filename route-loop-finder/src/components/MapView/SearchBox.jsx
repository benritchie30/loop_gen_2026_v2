import { useCallback, useEffect, useRef, useState } from 'react';
import { LocateFixed, Loader2, Search, X } from 'lucide-react';
import { searchPlaces } from '../../utils/geocode';
import './SearchBox.css';

const DEBOUNCE_MS = 250;
const MIN_CHARS = 3;

/**
 * Place search: a small icon at the top left that opens into a search field
 * when the pointer is over it (or on click / tap, or the "/" key).
 * Suggestions come as you type (Photon), ranked near the map's centre.
 * Choosing one calls onSelect({ lat, lng, name, bounds }); the locate button
 * calls onSelect with the browser's position.
 */
function SearchBox({ getCenter, onSelect }) {
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [active, setActive] = useState(-1);
    const [status, setStatus] = useState(null); // null | 'loading' | 'error' | 'empty' | 'locating'
    const inputRef = useRef(null);
    const rootRef = useRef(null);
    const open = hovered || focused;

    // "/" opens the search from anywhere (not while typing in another field).
    useEffect(() => {
        const onKey = (e) => {
            const tag = e.target?.tagName;
            if (e.key !== '/' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            e.preventDefault();
            inputRef.current?.focus();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // Suggestions as you type, debounced; a newer query cancels the older request.
    useEffect(() => {
        const q = query.trim();
        if (q.length < MIN_CHARS) {
            setResults([]);
            setStatus(null);
            return undefined;
        }
        const controller = new AbortController();
        const timer = setTimeout(async () => {
            setStatus('loading');
            try {
                const found = await searchPlaces(q, getCenter?.(), controller.signal);
                setResults(found);
                setActive(found.length ? 0 : -1);
                setStatus(found.length ? null : 'empty');
            } catch (err) {
                if (err.name !== 'AbortError') {
                    setResults([]);
                    setStatus('error');
                }
            }
        }, DEBOUNCE_MS);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [query, getCenter]);

    const choose = useCallback((result) => {
        if (!result) return;
        onSelect?.(result);
        setQuery('');
        setResults([]);
        setStatus(null);
        inputRef.current?.blur();
    }, [onSelect]);

    const locate = useCallback(() => {
        if (!navigator.geolocation) {
            setStatus('error');
            return;
        }
        setStatus('locating');
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                setStatus(null);
                choose({ lat: pos.coords.latitude, lng: pos.coords.longitude, name: null, bounds: null });
            },
            () => setStatus('denied'),
            { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 },
        );
    }, [choose]);

    const onKeyDown = (e) => {
        // Keys typed here are not app shortcuts (Enter would generate, arrows page routes).
        e.stopPropagation();
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((i) => Math.min(results.length - 1, i + 1));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
        } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(results[active] || results[0]);
        } else if (e.key === 'Escape') {
            setQuery('');
            inputRef.current?.blur();
        }
    };

    // Ready to type as soon as it opens (after it renders: a hidden field cannot take focus).
    useEffect(() => {
        if (hovered) inputRef.current?.focus({ preventScroll: true });
    }, [hovered]);

    const onMouseEnter = () => setHovered(true);

    const onMouseLeave = () => {
        setHovered(false);
        // Nothing typed: close again. With a query, it stays until focus moves away.
        if (!query.trim()) inputRef.current?.blur();
    };

    const message = {
        loading: 'Searching…',
        error: 'Search is not available right now.',
        empty: 'No places found.',
        locating: 'Finding your location…',
        denied: 'Location is not available (permission denied or no signal).',
    }[status];

    return (
        <div
            ref={rootRef}
            className={`search-box ${open ? 'search-box--open' : ''}`}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <div className="search-box__bar">
                <button
                    type="button"
                    className="search-box__icon"
                    onClick={() => setHovered(true)}
                    aria-label="Search for a place (/)"
                    title="Search for a place (/)"
                    tabIndex={open ? -1 : 0}
                >
                    {status === 'loading' ? <Loader2 size={18} className="search-box__spin" /> : <Search size={18} />}
                </button>
                <input
                    ref={inputRef}
                    className="search-box__input"
                    type="text"
                    placeholder="Search a place or address"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={onKeyDown}
                    onFocus={() => setFocused(true)}
                    onBlur={() => setFocused(false)}
                    aria-label="Search a place or address"
                    autoComplete="off"
                    spellCheck={false}
                    tabIndex={open ? 0 : -1}
                />
                {query && (
                    <button
                        type="button"
                        className="search-box__action"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setQuery('')}
                        aria-label="Clear"
                        title="Clear"
                    >
                        <X size={16} />
                    </button>
                )}
                <button
                    type="button"
                    className="search-box__action"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={locate}
                    aria-label="Use my location"
                    title="Use my location"
                    tabIndex={open ? 0 : -1}
                >
                    <LocateFixed size={16} />
                </button>
            </div>
            {open && (results.length > 0 || message) && (
                <ul className="search-box__results" role="listbox">
                    {results.map((r, i) => (
                        <li
                            key={r.id}
                            role="option"
                            aria-selected={i === active}
                            className={`search-box__result ${i === active ? 'is-active' : ''}`}
                            onMouseDown={(e) => e.preventDefault()}
                            onMouseEnter={() => setActive(i)}
                            onClick={() => choose(r)}
                        >
                            <span className="search-box__title">{r.title}</span>
                            {r.detail && <span className="search-box__detail">{r.detail}</span>}
                        </li>
                    ))}
                    {message && <li className="search-box__message">{message}</li>}
                </ul>
            )}
        </div>
    );
}

export default SearchBox;
