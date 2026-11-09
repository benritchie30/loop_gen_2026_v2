import { createContext, useContext } from 'react';

/**
 * Display units. Everything is stored and sent to the server in miles and
 * feet (route properties, settings); only what the user sees converts.
 * 'mi': miles, feet, ft/mi. 'km': kilometres, metres, m/km.
 */
export const KM_PER_MI = 1.609344;
export const M_PER_FT = 0.3048;

export const UnitsContext = createContext('mi');
export const useUnits = () => useContext(UnitsContext);

export function readUnits() {
    try {
        return localStorage.getItem('units') === 'km' ? 'km' : 'mi';
    } catch {
        return 'mi';
    }
}

/** Longest route the server builds an area for (LOOP_MAX_MILES on the server). */
export const MAX_ROUTE_MILES = 50;

/** Route length slider in display units: [min, max], step 1 (80 km is just under 50 mi). */
export function lengthSliderRange(units) {
    return units === 'km' ? [2, 80] : [1, MAX_ROUTE_MILES];
}

export function milesToDisplay(miles, units) {
    return units === 'km' ? miles * KM_PER_MI : miles;
}

export function displayToMiles(value, units) {
    return units === 'km' ? value / KM_PER_MI : value;
}

export function distanceUnit(units) {
    return units === 'km' ? 'km' : 'mi';
}

export function climbUnit(units) {
    return units === 'km' ? 'm' : 'ft';
}

/** "12.3 mi" / "19.8 km". */
export function formatDistance(miles, units, decimals = 1) {
    if (typeof miles !== 'number' || !Number.isFinite(miles)) return '—';
    return `${milesToDisplay(miles, units).toFixed(decimals)} ${distanceUnit(units)}`;
}

/** "1,240 ft" / "378 m". */
export function formatClimb(feet, units) {
    if (typeof feet !== 'number' || !Number.isFinite(feet)) return '—';
    const value = units === 'km' ? feet * M_PER_FT : feet;
    return `${Math.round(value).toLocaleString()} ${climbUnit(units)}`;
}

/** Climb per distance: "62 ft/mi" / "12 m/km". */
export function formatClimbRate(feetPerMile, units) {
    if (typeof feetPerMile !== 'number' || !Number.isFinite(feetPerMile)) return '—';
    const value = units === 'km' ? (feetPerMile * M_PER_FT) / KM_PER_MI : feetPerMile;
    return `${Math.round(value)} ${units === 'km' ? 'm/km' : 'ft/mi'}`;
}

/** Whole-number route length in display units, for slider labels. */
export function roundLength(miles, units) {
    return Math.round(milesToDisplay(miles, units));
}
