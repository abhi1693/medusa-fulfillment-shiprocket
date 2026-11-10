import { Courier } from "../types";

export function getCheapestCourier(couriers: Courier[]): Courier | null {
    const validCouriers = couriers.filter(
        (c) => !!c.rate && !isNaN(Number(c.rate))
    );

    if (validCouriers.length === 0) return null;

    return validCouriers.reduce((min, curr) => {
        return Number(curr.rate) < Number(min.rate) ? curr : min;
    });
}

export function filterAllowedCouriers(
    couriers: Courier[],
    allowedCourierIds: string[]
): Courier[] {
    return couriers.filter((courier) =>
        allowedCourierIds.includes(courier.courier_company_id)
    );
}

export function slugify(str: string) {
    return str
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-');
}

// Export validation utilities
export { validateAndSanitizePhone, validateAndSanitizePincode, requireField } from './validation'