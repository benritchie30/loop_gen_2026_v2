import { useMemo } from 'react';
import { Popup, useMap } from 'react-leaflet';
import PathMarker from './PathMarker';
import { groupByStart } from '../../utils/pathSetGroups';
import { distanceUnit, milesToDisplay, useUnits } from '../../utils/units';

function rangeText(range, units) {
    if (!range) return '';
    const [lo, hi] = range.map((miles) => milesToDisplay(miles, units).toFixed(1));
    return ` · ${lo === hi ? lo : `${lo}–${hi}`} ${distanceUnit(units)}`;
}

/** The generations at one pin: pick one to open. */
function SetMenu({ items, activeId, onOpen }) {
    const map = useMap();
    const units = useUnits();
    return (
        <Popup className="set-menu" closeButton={false} autoPan={false}>
            <div className="set-menu__title">{items.length} sets start here</div>
            <ul className="set-menu__list">
                {items.map((item) => (
                    <li key={item.id}>
                        <button
                            type="button"
                            className={`set-menu__item ${item.id === activeId ? 'is-active' : ''}`}
                            onClick={() => {
                                map.closePopup();
                                onOpen(item.id);
                            }}
                        >
                            <span className="set-menu__name">{item.name}</span>
                            <span className="set-menu__meta">
                                {item.pathCount} {item.pathCount === 1 ? 'route' : 'routes'}{rangeText(item.lengthRange, units)}
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </Popup>
    );
}

/**
 * Every generation's pin, one per start (generations that start at the same
 * place share it; its badge counts all their routes). Clicking a pin opens
 * its generation, or, when several start there, a menu of them. The pin of
 * the generation under the pointer in "Your loops" (hoveredSetId) is
 * highlighted.
 */
function SetPins({ markers, mode, activePathSetId, hoveredSetId = null, onOpen }) {
    const groups = useMemo(() => groupByStart(markers), [markers]);
    const hovered = hoveredSetId ? groups.find((g) => g.items.some((i) => i.id === hoveredSetId)) : null;

    return groups.map((group) => {
        const { items } = group;
        const active = mode === 'display' && items.some((i) => i.id === activePathSetId);
        const highlight = group === hovered;
        const count = items.reduce((sum, i) => sum + (i.pathCount || 0), 0);
        const single = items.length === 1;
        const title = single
            ? `${items[0].name} (${count} ${count === 1 ? 'route' : 'routes'})`
            : `${items.length} sets start here: ${items.map((i) => i.name).join(', ')}`;
        return (
            <PathMarker
                key={group.key}
                position={group.position}
                color={highlight ? 'highlight' : active ? 'active' : 'inactive'}
                title={title}
                zIndexOffset={highlight ? 800 : active ? 500 : 0}
                count={count}
                onClick={single ? () => onOpen(items[0].id) : undefined}
            >
                {!single && <SetMenu items={items} activeId={mode === 'display' ? activePathSetId : null} onOpen={onOpen} />}
            </PathMarker>
        );
    });
}

export default SetPins;
