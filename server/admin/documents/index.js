'use strict';

const {
  DOCUMENT_KINDS,
  DocumentError,
  buildDocument,
  buildQuoteModel,
  buildConfirmationModel,
  filenameFor,
  safeReference,
  priceModel,
  paymentModel
} = require('./model');
const { renderPdf, renderDocument } = require('./pdf');

module.exports = {
  DOCUMENT_KINDS,
  DocumentError,
  buildDocument,
  buildQuoteModel,
  buildConfirmationModel,
  filenameFor,
  safeReference,
  priceModel,
  paymentModel,
  renderPdf,
  renderDocument
};
