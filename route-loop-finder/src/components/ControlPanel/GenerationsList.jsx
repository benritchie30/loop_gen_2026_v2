import { useState } from 'react';
import { Check, Pencil, Trash2 } from 'lucide-react';
import { distanceUnit, milesToDisplay, useUnits } from '../../utils/units';

function when(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) {
        return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

/** "5.2–14.8 mi": the lengths the generation's routes actually have. */
function rangeText(range, units) {
    if (!range) return null;
    const [lo, hi] = range.map((miles) => milesToDisplay(miles, units).toFixed(1));
    return `${lo === hi ? lo : `${lo}–${hi}`} ${distanceUnit(units)}`;
}

/** A name being edited: Enter or leaving the field saves, Esc cancels. */
function NameEditor({ name, onSave, onCancel }) {
    const [draft, setDraft] = useState(name);
    const save = () => {
        if (draft.trim() && draft.trim() !== name) onSave(draft.trim());
        else onCancel();
    };
    return (
        <div className="gen-list__edit">
            <input
                className="gen-list__input"
                value={draft}
                autoFocus
                aria-label="Name"
                onChange={(e) => setDraft(e.target.value)}
                onFocus={(e) => e.target.select()}
                onBlur={save}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        e.stopPropagation();
                        save();
                    }
                    if (e.key === 'Escape') {
                        e.stopPropagation();
                        onCancel();
                    }
                }}
            />
            <button type="button" className="icon-btn icon-btn--small" onMouseDown={(e) => e.preventDefault()} onClick={save} aria-label="Save the name">
                <Check size={14} />
            </button>
        </div>
    );
}

/**
 * Saved generations (newest first) in their own scroll box: open one, rename
 * it, or delete it (with undo). Hovering a row shows which pin it is on the
 * map (onHover); the hover ends when the pointer leaves the list, so moving
 * between rows never drops it.
 */
function GenerationsList({ generations, onOpen, onDelete, onRename, onHover, showHeader = true }) {
    const units = useUnits();
    const [editing, setEditing] = useState(null);
    if (!generations.length) {
        return showHeader ? null : <div className="gen-empty fav-list__empty">No loops yet: set a start and press Find loops.</div>;
    }
    return (
        <div className="gen-list">
            {showHeader && (
                <div className="field-row">
                    <span className="section-label">Your loops</span>
                    <span className="field-hint">{generations.length}</span>
                </div>
            )}
            <ul className="gen-list__scroll" onMouseLeave={() => onHover?.(null)}>
                {generations.map((g) => (
                    <li key={g.id} className="gen-list__row" onMouseEnter={() => onHover?.(g.id)}>
                        {editing === g.id ? (
                            <NameEditor
                                name={g.name}
                                onSave={(name) => { onRename?.(g.id, name); setEditing(null); }}
                                onCancel={() => setEditing(null)}
                            />
                        ) : (
                            <button type="button" className="gen-list__open" onClick={() => onOpen(g.id)} title={`Open ${g.name}`}>
                                <span className="gen-list__name">{g.name}</span>
                                <span className="gen-list__meta">
                                    {[
                                        `${g.pathCount} ${g.pathCount === 1 ? 'route' : 'routes'}`,
                                        rangeText(g.lengthRange, units),
                                        when(g.createdAt),
                                    ].filter(Boolean).join(' · ')}
                                    {!g.isComplete && ' · finding…'}
                                </span>
                            </button>
                        )}
                        {editing !== g.id && (
                            <button
                                type="button"
                                className="icon-btn icon-btn--small gen-list__action"
                                onClick={() => setEditing(g.id)}
                                title="Rename"
                                aria-label={`Rename ${g.name}`}
                            >
                                <Pencil size={14} />
                            </button>
                        )}
                        <button
                            type="button"
                            className="icon-btn icon-btn--small gen-list__action gen-list__delete"
                            onClick={() => onDelete(g.id)}
                            title="Delete"
                            aria-label={`Delete ${g.name}`}
                        >
                            <Trash2 size={14} />
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export default GenerationsList;
