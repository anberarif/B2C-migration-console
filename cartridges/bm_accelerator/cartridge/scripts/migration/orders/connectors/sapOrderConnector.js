'use strict';

/**
 * SAP Commerce Cloud (Hybris) order connector.
 *
 * Stock OCC v2 has no site-wide, date-filterable order list endpoint — order
 * resources there are customer-scoped by design (see /users/{id}/orders and
 * /orders/{code}). To reach parity with the commercetools and Shopify
 * connectors (a single service-account call that pages through every order
 * since a date, optionally filtered by status), this connector targets a
 * small custom OCC endpoint:
 *
 *   GET {occBase}/orders/search?modifiedSince=<ISO date>&orderStatus=<code>
 *       &paymentStatus=<code>&pageSize=<n>&currentPage=<n>
 *
 * proposed to return the standard OCC pagination envelope:
 *
 *   { orders: [ <OrderWsDTO, fields=FULL> ... ],
 *     pagination: { currentPage, pageSize, totalPages, totalResults } }
 *
 * This is NOT a stock OCC endpoint — it requires a matching custom
 * extension/add-on on the SAP Commerce side. Once that extension exists,
 * confirm the real query params and response shape against a live payload
 * and adjust fetchOrdersPage()/countOrders() accordingly (mirrors how
 * sapConnector.js's product endpoints already talk to real OCC v2 routes).
 */

var sapApi = require('*/cartridge/scripts/migration/core/sapApi');

var DEFAULT_LIMIT  = 100;
var MAX_RETRIES    = 3;
var RETRY_DELAY_MS = 500;

/** Stock hybris OrderStatus enum, core + commerceservices extensions only, offered as a UI filter. */
var ORDER_STATE_VALUES = ['CREATED', 'ON_VALIDATION', 'COMPLETED', 'CANCELLED', 'PROCESSING_ERROR'];

/** Stock hybris PaymentStatus enum (Order.paymentStatus), core extension: NOTPAID, PARTPAID, PAID. */
var PAYMENT_STATE_VALUES = ['NOTPAID', 'PARTPAID', 'PAID'];

/**
 * Busy-wait for the given duration (SFCC has no setTimeout).
 * @param {number} ms - milliseconds to wait
 * @returns {void}
 */
function sleep(ms) {
    var start = Date.now();
    while (Date.now() - start < ms) { /* busy wait — SFCC has no setTimeout */ }
}

/**
 * Execute an HTTP call with retries on transient failures.
 * @param {Function} fn - function returning { status, data }
 * @returns {Object} the response once it succeeds or retries are exhausted
 */
function withRetry(fn) {
    var lastError = null;
    for (var attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            var res = fn();
            if (res.status === 429 || res.status >= 500) {
                lastError = new Error('HTTP ' + res.status);
                sleep(RETRY_DELAY_MS * (attempt + 1));
            } else {
                return res;
            }
        } catch (e) {
            lastError = e;
            sleep(RETRY_DELAY_MS * (attempt + 1));
        }
    }
    throw lastError || new Error('Request failed after retries');
}

/**
 * @param {string} token - OAuth access token
 * @returns {Object} request headers with Bearer auth
 */
function authHeaders(token) {
    return {
        Authorization:  'Bearer ' + token,
        'Content-Type': 'application/json'
    };
}

/**
 * @param {Object} [creds] - optional credential override
 * @returns {string} access token
 */
function authenticate(creds) {
    return sapApi.getAccessToken(creds);
}

/**
 * @param {number} years - how many years back from today
 * @returns {string} ISO date string
 */
function dateYearsAgo(years) {
    var d = new Date();
    d.setFullYear(d.getFullYear() - years);
    return d.toISOString();
}

/**
 * Build the query string for the proposed /orders/search endpoint.
 * @param {Object} options - filter options
 * @param {string} [options.sinceDate] - ISO date lower bound
 * @param {string} [options.orderState] - one of ORDER_STATE_VALUES
 * @param {string} [options.paymentState] - one of PAYMENT_STATE_VALUES
 * @returns {string} URL-encoded query string
 */
function buildOrdersWhere(options) {
    var parts = [];
    if (options.sinceDate) {
        parts.push('modifiedSince=' + encodeURIComponent(options.sinceDate));
    }
    if (options.orderState) {
        parts.push('orderStatus=' + encodeURIComponent(options.orderState));
    }
    if (options.paymentState) {
        parts.push('paymentStatus=' + encodeURIComponent(options.paymentState));
    }
    return parts.join('&');
}

/**
 * Fetch a single page of orders.
 * @param {string} token - OAuth access token
 * @param {Object} options - page + filter options
 * @param {string} [options.sinceDate] - ISO date lower bound
 * @param {string} [options.orderState] - SAP OrderStatus filter
 * @param {string} [options.paymentState] - SAP PaymentStatus filter
 * @param {number} options.offset - zero-based result offset
 * @param {number} options.limit - page size
 * @returns {Object} { results, total }
 */
function fetchOrdersPage(token, options) {
    var offset      = options.offset || 0;
    var limit       = options.limit || DEFAULT_LIMIT;
    var currentPage = Math.floor(offset / limit);
    var qs          = buildOrdersWhere(options) + '&pageSize=' + limit + '&currentPage=' + currentPage;

    var res = withRetry(function () {
        return sapApi.send('GET', sapApi.occBase() + '/orders/search?' + qs, authHeaders(token));
    });

    if (res.status !== 200) {
        throw new Error('Failed to fetch SAP Commerce orders (' + res.status + ')');
    }

    var pagination = res.data.pagination || {};
    var orders     = res.data.orders || [];

    return {
        results: orders,
        total:   pagination.totalResults !== undefined ? pagination.totalResults : orders.length
    };
}

/**
 * Fetch orders by date range with pagination.
 * @param {Object} options - filter + range options
 * @param {number} options.years - 1, 2, or 3
 * @param {number} [options.maxCount] - optional cap on orders fetched
 * @param {string} [options.orderState] - SAP OrderStatus filter
 * @param {string} [options.paymentState] - SAP PaymentStatus filter
 * @param {Object} [options.creds] - optional credential override
 * @returns {Object[]} raw SAP order objects
 */
function fetchOrdersByDateRange(options) {
    var years     = parseInt(String(options.years || 1), 10);
    var maxCount  = options.maxCount ? parseInt(String(options.maxCount), 10) : null;
    var token     = authenticate(options.creds);
    var sinceDate = dateYearsAgo(years);
    var all       = [];
    var offset    = 0;
    var total     = null;
    var results   = null;

    do {
        var page = fetchOrdersPage(token, {
            sinceDate:    sinceDate,
            orderState:   options.orderState || '',
            paymentState: options.paymentState || '',
            offset:       offset,
            limit:        DEFAULT_LIMIT
        });
        results = page.results;
        if (total === null) total = page.total;

        for (var i = 0; i < results.length; i++) {
            all.push(results[i]);
            if (maxCount && all.length >= maxCount) {
                return all;
            }
        }
        offset += results.length;
    } while (offset < total && results.length > 0);

    return all;
}

/**
 * Count orders matching filters without fetching full results.
 * @param {Object} options - filter + range options
 * @param {number} options.years - 1, 2, or 3
 * @param {number} [options.maxCount] - optional export cap
 * @param {string} [options.orderState] - SAP OrderStatus filter
 * @param {string} [options.paymentState] - SAP PaymentStatus filter
 * @param {Object} [options.creds] - optional credential override
 * @returns {Object} { total, exportCount }
 */
function countOrders(options) {
    var years     = parseInt(String(options.years || 1), 10);
    var maxCount  = options.maxCount ? parseInt(String(options.maxCount), 10) : null;
    var token     = authenticate(options.creds);
    var sinceDate = dateYearsAgo(years);
    var page      = fetchOrdersPage(token, {
        sinceDate:    sinceDate,
        orderState:   options.orderState || '',
        paymentState: options.paymentState || '',
        offset:       0,
        limit:        1
    });
    var total       = page.total || 0;
    var exportCount = total;

    if (maxCount && maxCount > 0 && maxCount < total) {
        exportCount = maxCount;
    }

    return {
        total:       total,
        exportCount: exportCount
    };
}

module.exports = {
    authenticate:            authenticate,
    fetchOrdersByDateRange:  fetchOrdersByDateRange,
    fetchOrdersPage:         fetchOrdersPage,
    countOrders:             countOrders,
    buildOrdersWhere:        buildOrdersWhere,
    dateYearsAgo:            dateYearsAgo,
    DEFAULT_LIMIT:           DEFAULT_LIMIT,
    MAX_RETRIES:             MAX_RETRIES,
    ORDER_STATE_VALUES:      ORDER_STATE_VALUES,
    PAYMENT_STATE_VALUES:    PAYMENT_STATE_VALUES
};
