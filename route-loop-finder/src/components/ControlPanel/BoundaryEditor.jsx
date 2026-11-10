import { ChevronLeft, Circle, Lasso, Square, Trash2, X } from 'lucide-react';
import { shapeLabel } from '../../utils/boundary';
import { useUnits } from '../../utils/units';

const TOOLS = [
    { id: 'circle', icon: Circle, label: 'Circle', key: 'C' },
    { id: 'box', icon: Square, label: 'Box', key: 'B' },
    { id: 'freeform', icon: Lasso, label: 'Freeform', key: 'F' },
];

/**
 * Drawing or editing a custom search boundary: a page over the panel. Its
 * shapes together are the area (several can be added); on the map each has
 * handles to adjust it. Use boundary (Enter) saves it and makes the plan use
 * it; Cancel (Esc) leaves everything as it was.
 */
function BoundaryEditor({ draft, setName, setTool, remove, onSave, onCancel, onDelete }) {
    const units = useUnits();
    return (
        <div className="advanced boundary-editor">
            <div className="advanced__header">
                <button type="button" className="icon-btn" onClick={onCancel} aria-label="Cancel" title="Cancel (Esc)">
                    <ChevronLeft size={18} />
                </button>
                <span className="panel-title">{draft.id ? 'Edit boundary' : 'New boundary'}</span>
            </div>
            <div className="advanced__body">
                <section className="advanced__section">
                    <label className="boundary-editor__name">
                        <span className="section-label">Name</span>
                        <input
                            type="text"
                            value={draft.name}
                            placeholder="e.g. North of the river"
                            onChange={(e) => setName(e.target.value)}
                            aria-label="Boundary name"
                        />
                    </label>
                </section>
                <section className="advanced__section">
                    <span className="section-label">Add a shape</span>
                    <div className="boundary-editor__tools" role="toolbar" aria-label="Add a shape">
                        {TOOLS.map(({ id, icon, label, key }) => {
                            const Icon = icon;
                            return (
                            <button
                                key={id}
                                type="button"
                                className={`boundary-editor__tool ${draft.tool === id ? 'is-active' : ''}`}
                                onClick={() => setTool(id)}
                                aria-pressed={draft.tool === id}
                                title={`${label} (${key}): drag on the map`}
                            >
                                <Icon size={15} />
                                {label}
                            </button>
                            );
                        })}
                    </div>
                    <p className="hint">
                        The shapes together are the area the routes stay in. Drag the white handles to adjust a
                        shape; on a freeform shape, drag a point, double-click it to remove it, or drag the small
                        handles between points to add one.
                    </p>
                </section>
                <section className="advanced__section">
                    <span className="section-label">Shapes</span>
                    {draft.shapes.length === 0 ? (
                        <p className="hint">None yet: pick a shape and drag on the map.</p>
                    ) : (
                        <ul className="boundary-editor__shapes">
                            {draft.shapes.map((shape, i) => (
                                <li key={i}>
                                    <span>{shapeLabel(shape, units)}</span>
                                    <button
                                        type="button"
                                        className="icon-btn icon-btn--small"
                                        onClick={() => remove(i)}
                                        aria-label={`Remove shape ${i + 1}`}
                                        title="Remove this shape"
                                    >
                                        <X size={14} />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>
            <div className="boundary-editor__foot">
                {onDelete && (
                    <button type="button" className="icon-btn" onClick={onDelete} title="Delete this saved boundary" aria-label="Delete boundary">
                        <Trash2 size={16} />
                    </button>
                )}
                <button type="button" className="link-btn" onClick={onCancel}>Cancel</button>
                <button
                    type="button"
                    className="btn-primary"
                    onClick={onSave}
                    disabled={draft.shapes.length === 0}
                    title="Save it and use it for the plan (Enter)"
                >
                    Use boundary
                </button>
            </div>
        </div>
    );
}

export default BoundaryEditor;
