'use strict';

/**
 * Maps a SAP Commerce Cloud (Hybris) OCC order — from the proposed
 * /orders/search endpoint, one entry per stock OrderWsDTO (fields=FULL) —
 * into a CanonicalOrder. Field names below follow the standard OCC v2
 * Order/Address/Entry DTO shape; confirm against a live payload once the
 * custom search endpoint exists and adjust names here if the instance's
 * extension differs (same "verify against real data" step sapTransformer.js
 * already follows for products).
 */

var canonicalOrder      = require('*/cartridge/scripts/migration/orders/canonicalOrder');
var localizedString     = require('*/cartridge/scripts/migration/orders/localizedString').localizedString;
var orderShippingStatus = require('*/cartridge/scripts/migration/orders/orderShippingStatus');

/**
 * @param {number|string} val - a decimal amount, or an OCC Price sub-object's raw value
 * @returns {number} parsed amount, or 0 if not a valid number
 */
function parseMoney(val) {
    var n = parseFloat(val === undefined || val === null ? '0' : val);
    return Number.isNaN(n) ? 0 : n;
}

/**
 * OCC region isocode is "{country}-{region}" (e.g. "US-CA"); SFCC state-code
 * wants just the region part.
 * @param {Object} region - { isocode }
 * @returns {string} the region segment of the isocode, or '' if absent
 */
function regionCode(region) {
    if (!region || !region.isocode) return '';
    var iso = String(region.isocode);
    var idx = iso.lastIndexOf('-');
    return idx >= 0 ? iso.substring(idx + 1) : iso;
}

/**
 * @param {Object} addr - OCC AddressWsDTO
 * @returns {Object} canonical address
 */
function mapAddress(addr) {
    if (!addr) return canonicalOrder.emptyAddress();
    return {
        firstName:   addr.firstName   || '',
        lastName:    addr.lastName    || '',
        company:     addr.companyName || '',
        address1:    addr.line1       || '',
        address2:    addr.line2       || '',
        city:        addr.town        || '',
        stateCode:   regionCode(addr.region),
        postalCode:  addr.postalCode  || '',
        countryCode: addr.country && addr.country.isocode || '',
        phone:       addr.phone       || addr.cellphone || ''
    };
}

/**
 * @param {Object} sapOrder - raw OCC order
 * @returns {Object} canonical customer
 */
function mapCustomer(sapOrder) {
    var user = sapOrder.user || {};
    var billing = sapOrder.paymentAddress || {};
    var firstName = billing.firstName || '';
    var lastName  = billing.lastName  || '';

    if (user.name) {
        var parts = String(user.name).trim().split(/\s+/);
        if (parts.length) {
            firstName = parts[0];
            lastName  = parts.length > 1 ? parts.slice(1).join(' ') : lastName;
        }
    }

    return {
        id:        user.uid || '',
        email:     user.uid && user.uid.indexOf('@') >= 0 ? user.uid : (billing.email || ''),
        firstName: firstName,
        lastName:  lastName
    };
}

/**
 * @param {boolean} isNet - OCC order's `net` flag (true = net pricing, false = gross)
 * @returns {string} canonical 'net' or 'gross'
 */
function mapTaxation(isNet) {
    return isNet === true ? 'net' : 'gross';
}

/**
 * @param {Object[]} taxValues - OCC TaxValueWsDTO[]
 * @returns {number} summed tax amount
 */
function sumTax(taxValues) {
    var total = 0;
    var i;
    for (i = 0; i < (taxValues || []).length; i++) {
        total += parseMoney(taxValues[i].value);
    }
    return total;
}

/**
 * @param {Object} sapOrder - raw OCC order
 * @param {boolean} isNet - whether the order's prices are net (true) or gross (false)
 * @returns {Object[]} canonical line items
 */
function mapLineItems(sapOrder, isNet) {
    var entries  = sapOrder.entries || [];
    var currency = sapOrder.totalPrice && sapOrder.totalPrice.currencyIso || '';
    var mapped   = [];
    var i;

    for (i = 0; i < entries.length; i++) {
        var entry   = entries[i];
        var product = entry.product || {};
        var qty     = entry.quantity || 1;
        var taxAmt  = sumTax(entry.taxValues);
        var lineTotal = entry.totalPrice ? parseMoney(entry.totalPrice.value)
            : parseMoney(entry.basePrice && entry.basePrice.value) * qty;
        var grossAmt = isNet ? lineTotal + taxAmt : lineTotal;
        var netAmt   = isNet ? lineTotal : lineTotal - taxAmt;

        mapped.push({
            id:         entry.entryNumber !== undefined ? String(entry.entryNumber) : String(i + 1),
            sku:        product.code || '',
            name:       localizedString(product.name, product.code || ''),
            quantity:   qty,
            unitPrice:  parseMoney(entry.basePrice && entry.basePrice.value),
            taxAmount:  taxAmt,
            grossPrice: grossAmt,
            netPrice:   netAmt,
            currency:   currency
        });
    }
    return mapped;
}

/**
 * OCC's order-level totalTax is a single figure, not itemized jurisdictions
 * like commercetools' taxPortions or Shopify's tax_lines — represented here
 * as one synthetic tax entry.
 * @param {Object} sapOrder - raw OCC order
 * @returns {Object[]} zero or one synthetic canonical tax entries
 */
function mapTaxes(sapOrder) {
    var totalTax = sapOrder.totalTax && parseMoney(sapOrder.totalTax.value);
    if (!totalTax) return [];
    return [{ name: 'Tax', amount: totalTax, rate: 0 }];
}

/**
 * @param {Object} sapOrder - raw OCC order
 * @returns {Object[]} canonical discounts (vouchers + order-level discount)
 */
function mapDiscounts(sapOrder) {
    var discounts = [];
    var vouchers   = sapOrder.appliedVouchers || [];
    var i;

    for (i = 0; i < vouchers.length; i++) {
        var v = vouchers[i];
        discounts.push({
            id:          v.voucherCode || ('voucher-' + i),
            code:        v.voucherCode || '',
            amount:      parseMoney(v.value),
            description: v.name || 'Voucher'
        });
    }

    if (sapOrder.orderDiscounts && sapOrder.orderDiscounts.value) {
        discounts.push({
            id:          'order-discount',
            code:        'ORDER_DISCOUNT',
            amount:      parseMoney(sapOrder.orderDiscounts.value),
            description: 'Order discount'
        });
    }

    return discounts;
}

/**
 * OCC's deliveryCost is a single figure with no net/tax split, so both the
 * net and gross shipping amounts are reported as that same figure and tax
 * is left at 0 — same simplification as mapTaxes() above.
 * @param {Object} sapOrder - raw OCC order
 * @returns {Object[]} single synthetic canonical shipment
 */
function mapShipments(sapOrder) {
    var deliveryCost = sapOrder.deliveryCost ? parseMoney(sapOrder.deliveryCost.value) : 0;
    var shipNet   = deliveryCost;
    var shipTax   = 0;
    var shipGross = deliveryCost;

    return [{
        shipmentId:      '000001',
        status:          orderShippingStatus.mapShippingStatus(sapOrder.deliveryStatus || sapOrder.status),
        shippingMethod:  sapOrder.deliveryMode && sapOrder.deliveryMode.name || 'STANDARD_SHIPPING',
        shippingAddress: mapAddress(sapOrder.deliveryAddress),
        shippingNet:     shipNet,
        shippingTax:     shipTax,
        shippingGross:   shipGross
    }];
}

/**
 * @param {Object} sapOrder - raw OCC order
 * @returns {Object[]} zero or one synthetic canonical payment record
 */
function mapPayments(sapOrder) {
    if (!sapOrder.paymentInfo && !sapOrder.paymentStatus) return [];
    var paymentInfo = sapOrder.paymentInfo || {};
    return [{
        method:        paymentInfo.paymentType && paymentInfo.paymentType.code || 'CARD',
        amount:        sapOrder.totalPrice ? parseMoney(sapOrder.totalPrice.value) : null,
        transactionId: sapOrder.code || ''
    }];
}

/**
 * Stock hybris OrderStatus is a large, version-specific enum; this maps the
 * curated subset offered as a UI filter (see sapOrderConnector.ORDER_STATE_VALUES)
 * and falls back to an uppercased pass-through for anything else.
 * @param {string} status - raw OCC OrderStatus value
 * @returns {string} canonical order status
 */
function mapOrderStatus(status) {
    var map = {
        CREATED:          'NEW',
        ON_VALIDATION:    'OPEN',
        PROCESSING_ERROR: 'OPEN',
        COMPLETED:        'COMPLETED',
        CANCELLED:        'CANCELLED',
        CANCELLING:       'CANCELLED'
    };
    return map[status] || (status || '').toUpperCase() || 'NEW';
}

/**
 * Stock hybris PaymentStatus enum: NOTPAID, PARTPAID, PAID.
 * @param {string} status - raw OCC PaymentStatus value
 * @returns {string} canonical payment status
 */
function mapPaymentStatus(status) {
    var map = {
        PAID:     'PAID',
        NOTPAID:  'NOT_PAID',
        PARTPAID: 'NOT_PAID'
    };
    return map[status] || 'NOT_PAID';
}

/**
 * Convert a SAP Commerce order into a CanonicalOrder.
 * @param {Object} sapOrder - raw OCC order (fields=FULL)
 * @returns {Object} CanonicalOrder
 */
function mapOrder(sapOrder) {
    var order = canonicalOrder.createEmpty();
    var isNet = sapOrder.net === true;

    order.orderNumber     = sapOrder.code || '';
    order.currency        = sapOrder.totalPrice && sapOrder.totalPrice.currencyIso || '';
    order.createdAt       = sapOrder.created || '';
    order.customerLocale  = sapOrder.language && sapOrder.language.isocode || 'en_US';
    order.taxation        = mapTaxation(isNet);
    order.customer        = mapCustomer(sapOrder);
    order.billingAddress  = mapAddress(sapOrder.paymentAddress);
    order.shippingAddress = mapAddress(sapOrder.deliveryAddress);
    order.lineItems       = mapLineItems(sapOrder, isNet);
    order.taxes           = mapTaxes(sapOrder);
    order.discounts       = mapDiscounts(sapOrder);
    order.shipments       = mapShipments(sapOrder);
    order.payments        = mapPayments(sapOrder);
    order.status          = mapOrderStatus(sapOrder.status);
    order.paymentStatus   = mapPaymentStatus(sapOrder.paymentStatus);

    // customAttributes intentionally left empty: the proposed custom search
    // endpoint's contract for order-level custom fields is not yet defined
    // (mirrors sapConnector.js's Phase-1 "zero fields" scope for Order).

    order.merchandiseTotal = sapOrder.subTotal ? parseMoney(sapOrder.subTotal.value) : 0;
    order.shippingTotal    = sapOrder.deliveryCost ? parseMoney(sapOrder.deliveryCost.value) : 0;
    order.taxTotal         = sapOrder.totalTax ? parseMoney(sapOrder.totalTax.value) : 0;
    order.orderTotal       = sapOrder.totalPrice ? parseMoney(sapOrder.totalPrice.value) : 0;

    return order;
}

/**
 * @param {Object[]} sapOrders - raw OCC orders
 * @returns {Object[]} canonical orders
 */
function mapOrders(sapOrders) {
    var mapped = [];
    var i;
    for (i = 0; i < sapOrders.length; i++) {
        mapped.push(mapOrder(sapOrders[i]));
    }
    return mapped;
}

module.exports = {
    mapOrder:   mapOrder,
    mapOrders:  mapOrders,
    mapAddress: mapAddress
};
