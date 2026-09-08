// src/controllers/supplierInvoice.controller.js
import {
  createSupplierInvoice,
  listSupplierInvoices,
  getSupplierInvoiceById,
  voidSupplierInvoice,
  SUPPLIER_INVOICE_NOT_FOUND,
  SUPPLIER_NOT_FOUND,
  NOT_A_SUPPLIER,
  SUPPLIER_INACTIVE,
  SUPPLIER_INVOICE_DUPLICATE,
  SUPPLIER_INVOICE_BOOKING_NOT_FOUND,
} from '#services/supplierInvoice.service.js';
import {
  validateSupplierInvoiceCreate,
  validateSupplierInvoiceQuery,
} from '#validations/supplierInvoice.validation.js';
import { uuidParamSchema } from '#validations/common.js';
import logger from '#config/logger.js';

// Zod v4 reports on `.issues`; `.errors` is undefined and drops every detail.
const zodError = (res, error) =>
  res.status(400).json({
    success: false,
    error: 'Validation error',
    details: error.issues,
  });

const isZod = (error) => error.name === 'ZodError';

// A bad supplier reference is the caller's mistake, not a server fault, so
// these answer 4xx rather than falling through to a 500.
const STATUS = {
  [SUPPLIER_INVOICE_NOT_FOUND]: 404,
  [SUPPLIER_INVOICE_BOOKING_NOT_FOUND]: 404,
  [SUPPLIER_NOT_FOUND]: 404,
  [NOT_A_SUPPLIER]: 422,
  [SUPPLIER_INACTIVE]: 422,
  [SUPPLIER_INVOICE_DUPLICATE]: 409,
};

const send = (res, error, fallback) => {
  const status = STATUS[error.message];
  if (status) {
    return res.status(status).json({ success: false, error: error.message });
  }
  return fallback();
};

export const createSupplierInvoiceController = async (req, res, next) => {
  try {
    const validated = validateSupplierInvoiceCreate(req.body);
    const invoice = await createSupplierInvoice(validated);
    res.status(201).json({ success: true, data: invoice });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);
    // decimalToCents rejects a malformed amount; that is a 400, not a 500.
    if (error.message.startsWith('[money]')) {
      return res.status(400).json({ success: false, error: error.message });
    }
    return send(res, error, () => {
      logger.error('[Supplier Invoice Controller] Create error:', error);
      next(error);
    });
  }
};

export const listSupplierInvoicesController = async (req, res, next) => {
  try {
    const filters = validateSupplierInvoiceQuery(req.query);
    const { data, total, page, limit } = await listSupplierInvoices(filters);
    res.json({ success: true, data, count: data.length, total, page, limit });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);
    logger.error('[Supplier Invoice Controller] List error:', error);
    next(error);
  }
};

export const getSupplierInvoiceController = async (req, res, next) => {
  try {
    // Validated before the query. A malformed id reaches a uuid column as a
    // Postgres cast error, which errorHandler treats as a database failure and
    // answers 500 -- a server fault for what the caller got wrong.
    const { id } = uuidParamSchema.parse(req.params);
    const invoice = await getSupplierInvoiceById(id);
    res.json({ success: true, data: invoice });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);
    return send(res, error, () => {
      logger.error('[Supplier Invoice Controller] Get error:', error);
      next(error);
    });
  }
};

export const voidSupplierInvoiceController = async (req, res, next) => {
  try {
    const { id } = uuidParamSchema.parse(req.params);
    const invoice = await voidSupplierInvoice(id);
    res.json({
      success: true,
      message: 'Invoice voided and its payable reversed',
      data: invoice,
    });
  } catch (error) {
    if (isZod(error)) return zodError(res, error);
    return send(res, error, () => {
      logger.error('[Supplier Invoice Controller] Void error:', error);
      next(error);
    });
  }
};
